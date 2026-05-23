export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS cho phép App kết nối
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
      "Access-Control-Allow-Headers": "Content-Type, Admin-Token",
    };
    if (method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    
    // Hàm Response chung
    const res = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const isAdmin = request.headers.get("Admin-Token") === env.ADMIN_TOKEN;

    try {
      // ==========================================
      // NHÓM 1: PUBLIC / HỌC SINH
      // ==========================================
      
      // 1. Đăng nhập
      if (path === "/api/login" && method === "POST") {
        const { username, password } = await request.json();
        const user = await env.DB.prepare(`SELECT user_id, username, display_name, role, status FROM users WHERE username=? AND password=?`).bind(username, password).first();
        if (!user) return res({ error: "Sai tài khoản mật khẩu!" }, 401);
        if (user.status === 'banned') return res({ error: "Tài khoản đã bị khóa!" }, 403);
        return res({ success: true, user });
      }

      // 2. Lấy dữ liệu bài thi (Load toàn bộ Sections, Materials, Questions)
      if (path === "/api/quiz/data" && method === "GET") {
        const quizId = url.searchParams.get("quiz_id");
        
        const sections = await env.DB.prepare(`SELECT * FROM sections WHERE quiz_id=?`).bind(quizId).all();
        const materials = await env.DB.prepare(`SELECT * FROM materials WHERE quiz_id=?`).bind(quizId).all();
        const questions = await env.DB.prepare(`SELECT * FROM questions WHERE quiz_id=? ORDER BY sort_order`).bind(quizId).all();
        const options = await env.DB.prepare(`SELECT o.* FROM question_options o JOIN questions q ON o.question_id = q.question_id WHERE q.quiz_id=?`).bind(quizId).all();

        // Ghép options vào questions
        const optMap = {};
        options.results.forEach(o => {
          if(!optMap[o.question_id]) optMap[o.question_id] = {};
          optMap[o.question_id][o.option_id] = o.content;
        });

        const formattedQuestions = questions.results.map(q => ({
          ...q,
          options: q.type === 'short_answer' ? null : optMap[q.question_id] || {}
        }));

        return res({ 
          success: true, 
          test: { sections: sections.results, materials: materials.results, questions: formattedQuestions } 
        });
      }

      // 3. Bắt đầu làm bài
      if (path === "/api/quiz/start" && method === "POST") {
        const { user_id, quiz_id, start_time } = await request.json();
        const { meta } = await env.DB.prepare(`INSERT INTO submissions (user_id, quiz_id, start_time) VALUES (?,?,?)`).bind(user_id, quiz_id, start_time).run();
        return res({ success: true, submission_id: meta.last_row_id });
      }

      // 4. Nộp bài (Chỉ cần gửi đáp án, DB tự chấm)
      if (path === "/api/quiz/submit" && method === "POST") {
        const { submission_id, end_time, answers } = await request.json();
        
        // Tạo batch insert đáp án của user
        const stmts = Object.entries(answers).map(([qId, selected]) => {
          const jsonArr = JSON.stringify(Array.isArray(selected) ? selected : [selected]);
          return env.DB.prepare(`INSERT INTO submission_answers (submission_id, question_id, selected_ids) VALUES (?,?,?)`).bind(submission_id, qId, jsonArr);
        });

        // Câu lệnh cuối: Update trạng thái -> Kích hoạt Trigger tự chấm điểm
        stmts.push(env.DB.prepare(`UPDATE submissions SET end_time=?, status='submitted' WHERE submission_id=?`).bind(end_time, submission_id));
        await env.DB.batch(stmts);
        
        // Lấy kết quả DB vừa tự tính
        const result = await env.DB.prepare(`SELECT * FROM quiz_results WHERE submission_id=?`).bind(submission_id).first();
        return res({ success: true, result });
      }

      // ==========================================
      // NHÓM 2: ADMIN (Bắt buộc có Header Admin-Token)
      // ==========================================
      if (path.startsWith("/api/admin/") && !isAdmin) return res({ error: "Thiếu hoặc sai Admin-Token" }, 403);

      // 1. Upload Quiz từ JSON
      if (path === "/api/admin/upload-quiz" && method === "POST") {
        const { test } = await request.json();
        const quizId = "QUIZ_" + Date.now(); // Tạo ID bài thi tự động
        const queries = [];

        // Insert Sections
        (test.sections || []).forEach(s => queries.push(env.DB.prepare(`INSERT INTO sections (section_id, quiz_id, title) VALUES (?,?,?)`).bind(s.id, quizId, s.title)));
        
        // Insert Materials
        (test.materials || []).forEach(m => queries.push(env.DB.prepare(`INSERT INTO materials (material_id, quiz_id, type, content) VALUES (?,?,?,?)`).bind(m.id, quizId, m.type, m.content)));

        // Insert Questions
        for (const q of test.questions) {
          const shortText = q.type === 'short_answer' ? q.correct_answers[0] : null;
          queries.push(env.DB.prepare(`INSERT INTO questions (question_id, quiz_id, section_id, material_id, type, content, short_answer_text, sort_order) VALUES (?,?,?,?,?,?,?,?)`)
            .bind(q.id, quizId, q.section_id || null, q.material_id || null, q.type, q.question, shortText, q.order));

          // Bỏ qua options nếu là short_answer
          if (q.options && q.type !== 'short_answer') {
            Object.entries(q.options).forEach(([optId, text]) => {
              const isCorrect = q.correct_answers.includes(optId) ? 1 : 0;
              queries.push(env.DB.prepare(`INSERT INTO question_options (option_id, question_id, content, is_correct) VALUES (?,?,?,?)`).bind(optId, q.id, text, isCorrect));
            });
          }
        }
        await env.DB.batch(queries);
        return res({ success: true, message: "Upload thành công!", quiz_id: quizId });
      }

      // 2. Quản lý người dùng: Lấy danh sách + Thống kê
      if (path === "/api/admin/users" && method === "GET") {
        const data = await env.DB.prepare(`SELECT * FROM view_admin_users`).all();
        return res({ success: true, data: data.results });
      }

      // 3. Sửa thông tin User / Đổi mật khẩu / Ban tài khoản
      if (path === "/api/admin/user" && method === "PATCH") {
        const { user_id, username, display_name, password, status } = await request.json();
        let q = "UPDATE users SET ", binds = [];
        if (username) { q += "username=?, "; binds.push(username); }
        if (display_name) { q += "display_name=?, "; binds.push(display_name); }
        if (password) { q += "password=?, "; binds.push(password); }
        if (status) { q += "status=?, "; binds.push(status); }
        
        q = q.slice(0, -2) + " WHERE user_id=?"; binds.push(user_id);
        await env.DB.prepare(q).bind(...binds).run();
        return res({ success: true, message: "Đã cập nhật User!" });
      }

      // 4. Thống kê câu hỏi khó (Nhiều người sai nhất)
      if (path === "/api/admin/stats/hard-questions" && method === "GET") {
        const data = await env.DB.prepare(`SELECT * FROM view_hard_questions LIMIT 50`).all();
        return res({ success: true, data: data.results });
      }

      // 5. Xem chi tiết bài làm của một học sinh
      if (path === "/api/admin/review" && method === "GET") {
        const sid = url.searchParams.get("submission_id");
        const details = await env.DB.prepare(`
          SELECT sa.question_id, q.content, sa.selected_ids, sa.is_correct 
          FROM submission_answers sa 
          JOIN questions q ON sa.question_id = q.question_id 
          WHERE sa.submission_id=?
        `).bind(sid).all();
        return res({ success: true, data: details.results.map(d => ({ ...d, selected: JSON.parse(d.selected_ids) })) });
      }

      return res({ error: "Không tìm thấy Route" }, 404);

    } catch (err) {
      // DEBUG: LUÔN TRẢ VỀ LỖI CHI TIẾT
      console.error(err);
      return res({ 
        error: "Server Error", 
        message: err.message, 
        stack: err.stack // In thẳng dòng code lỗi ra màn hình cho dễ sửa
      }, 500);
    }
  }
};
