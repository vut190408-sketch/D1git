export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS cho phép Frontend/App kết nối tới API
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
      "Access-Control-Allow-Headers": "Content-Type, Admin-Token",
    };
    if (method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    
    // Hàm Response chung
    const res = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    // Kiểm tra quyền Admin
    const isAdmin = request.headers.get("Admin-Token") === env.ADMIN_TOKEN;

    try {
      // ==========================================
      // NHÓM 1: PUBLIC / HỌC SINH (Không cần Token)
      // ==========================================
      
      // 1. Đăng nhập
      if (path === "/api/login" && method === "POST") {
        const { username, password } = await request.json();
        const user = await env.DB.prepare(`SELECT user_id, username, display_name, role, status FROM users WHERE username=? AND password=?`).bind(username, password).first();
        if (!user) return res({ error: "Sai tài khoản mật khẩu!" }, 401);
        if (user.status === 'banned') return res({ error: "Tài khoản đã bị khóa!" }, 403);
        return res({ success: true, user });
      }

      // 2. Lấy toàn bộ dữ liệu Đề thi (Sections, Materials, Questions, Options)
      if (path === "/api/quiz/data" && method === "GET") {
        const quizId = url.searchParams.get("quiz_id");
        
        const sections = await env.DB.prepare(`SELECT * FROM sections WHERE quiz_id=?`).bind(quizId).all();
        const materials = await env.DB.prepare(`SELECT * FROM materials WHERE quiz_id=?`).bind(quizId).all();
        const questions = await env.DB.prepare(`SELECT * FROM questions WHERE quiz_id=? ORDER BY sort_order`).bind(quizId).all();
        const options = await env.DB.prepare(`SELECT o.* FROM question_options o JOIN questions q ON o.question_id = q.question_id WHERE q.quiz_id=?`).bind(quizId).all();

        // Nhóm các options vào từng question
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
          test: { 
            sections: sections.results, 
            materials: materials.results, 
            questions: formattedQuestions 
          } 
        });
      }

      // 3. Bắt đầu làm bài thi
      if (path === "/api/quiz/start" && method === "POST") {
        const { user_id, quiz_id, start_time } = await request.json();
        const { meta } = await env.DB.prepare(`INSERT INTO submissions (user_id, quiz_id, start_time) VALUES (?,?,?)`).bind(user_id, quiz_id, start_time).run();
        return res({ success: true, submission_id: meta.last_row_id });
      }

      // 4. Nộp bài (Chỉ cần nộp đáp án đã chọn, Database tự tính toán)
      if (path === "/api/quiz/submit" && method === "POST") {
        const { submission_id, end_time, answers } = await request.json();
        
        // Tạo batch insert các đáp án của user
        const stmts = Object.entries(answers).map(([qId, selected]) => {
          const jsonArr = JSON.stringify(Array.isArray(selected) ? selected : [selected]);
          return env.DB.prepare(`INSERT INTO submission_answers (submission_id, question_id, selected_ids) VALUES (?,?,?)`).bind(submission_id, qId, jsonArr);
        });

        // Câu lệnh cuối: Update thời gian kết thúc -> Sẽ tự động kích hoạt Trigger chấm điểm trong SQL
        stmts.push(env.DB.prepare(`UPDATE submissions SET end_time=?, status='submitted' WHERE submission_id=?`).bind(end_time, submission_id));
        await env.DB.batch(stmts);
        
        // Lấy kết quả DB vừa tự chấm xong
        const result = await env.DB.prepare(`SELECT * FROM quiz_results WHERE submission_id=?`).bind(submission_id).first();
        return res({ success: true, result });
      }

      // ==========================================
      // NHÓM 2: ADMIN (Bắt buộc có Header Admin-Token)
      // ==========================================
      if (path.startsWith("/api/admin/") && !isAdmin) {
        return res({ error: "Thiếu hoặc sai Admin-Token" }, 403);
      }

      // 1. Upload Quiz từ JSON (ĐÃ SỬA LỖI UNDEFINED)
      if (path === "/api/admin/upload-quiz" && method === "POST") {
        const { test } = await request.json();
        const quizId = "QUIZ_" + Date.now(); // Tạo ID tự động
        const queries = [];

        // Insert Sections (Nếu có)
        if (test.sections && Array.isArray(test.sections)) {
          test.sections.forEach(s => {
            queries.push(env.DB.prepare(`INSERT INTO sections (section_id, quiz_id, title) VALUES (?,?,?)`)
              .bind(s.id, quizId, s.title || ""));
          });
        }
        
        // Insert Materials (Nếu có)
        if (test.materials && Array.isArray(test.materials)) {
          test.materials.forEach(m => {
            queries.push(env.DB.prepare(`INSERT INTO materials (material_id, quiz_id, type, content) VALUES (?,?,?,?)`)
              .bind(m.id, quizId, m.type || "", m.content || ""));
          });
        }

        // Insert Questions
        if (test.questions && Array.isArray(test.questions)) {
          for (const q of test.questions) {
            
            // Ép CÁC GIÁ TRỊ CÓ THỂ LÀ UNDEFINED VỀ NULL HOẶC DEFAULT
            const sectionId = q.section_id || null;
            const materialId = q.material_id || null;
            const qType = q.type || "multiple_choice";
            const qContent = q.question || q.content || "";
            const qOrder = q.order || 0;
            const shortText = (qType === 'short_answer' && q.correct_answers) ? q.correct_answers[0] : null;

            queries.push(env.DB.prepare(`
              INSERT INTO questions (question_id, quiz_id, section_id, material_id, type, content, short_answer_text, sort_order) 
              VALUES (?,?,?,?,?,?,?,?)
            `).bind(q.id, quizId, sectionId, materialId, qType, qContent, shortText, qOrder));

            // Chỉ insert options nếu không phải câu hỏi điền từ ngắn
            if (q.options && typeof q.options === 'object' && qType !== 'short_answer') {
              Object.entries(q.options).forEach(([optId, text]) => {
                const isCorrect = (q.correct_answers || []).includes(optId) ? 1 : 0;
                queries.push(env.DB.prepare(`INSERT INTO question_options (option_id, question_id, content, is_correct) VALUES (?,?,?,?)`)
                  .bind(optId, q.id, text || "", isCorrect));
              });
            }
          }
        }
        
        // Chạy tất cả lệnh vào Database
        await env.DB.batch(queries);
        return res({ success: true, message: "Upload thành công!", quiz_id: quizId });
      }

      // 2. Admin: Lấy danh sách Users & Thống kê điểm
      if (path === "/api/admin/users" && method === "GET") {
        const data = await env.DB.prepare(`SELECT * FROM view_admin_users`).all();
        return res({ success: true, data: data.results });
      }

      // 3. Admin: Sửa thông tin User / Đổi mật khẩu / Khóa tài khoản
      if (path === "/api/admin/user" && method === "PATCH") {
        const { user_id, username, display_name, password, status } = await request.json();
        let q = "UPDATE users SET ", binds = [];
        if (username) { q += "username=?, "; binds.push(username); }
        if (display_name) { q += "display_name=?, "; binds.push(display_name); }
        if (password) { q += "password=?, "; binds.push(password); }
        if (status) { q += "status=?, "; binds.push(status); }
        
        if (binds.length === 0) return res({ error: "Không có dữ liệu cập nhật" }, 400);

        q = q.slice(0, -2) + " WHERE user_id=?"; 
        binds.push(user_id);
        await env.DB.prepare(q).bind(...binds).run();
        return res({ success: true, message: "Đã cập nhật User thành công!" });
      }

      // 4. Admin: Lấy danh sách câu hỏi khó (nhiều người sai nhất)
      if (path === "/api/admin/stats/hard-questions" && method === "GET") {
        const data = await env.DB.prepare(`SELECT * FROM view_hard_questions LIMIT 50`).all();
        return res({ success: true, data: data.results });
      }

      // 5. Admin: Xem lại chi tiết từng bài làm của học sinh
      if (path === "/api/admin/review" && method === "GET") {
        const sid = url.searchParams.get("submission_id");
        if(!sid) return res({ error: "Thiếu submission_id" }, 400);

        const details = await env.DB.prepare(`
          SELECT sa.question_id, q.content, sa.selected_ids, sa.is_correct 
          FROM submission_answers sa 
          JOIN questions q ON sa.question_id = q.question_id 
          WHERE sa.submission_id=?
        `).bind(sid).all();
        
        // Parse lại selected_ids từ chuỗi JSON về mảng cho Admin dễ đọc
        const formattedData = details.results.map(d => ({ 
          ...d, 
          selected: JSON.parse(d.selected_ids) 
        }));

        return res({ success: true, data: formattedData });
      }

      // Route không tồn tại
      return res({ error: "Không tìm thấy API này" }, 404);

    } catch (err) {
      // DEBUG: Bắt mọi lỗi và in thẳng ra màn hình (kèm dòng code bị lỗi)
      console.error(err);
      return res({ 
        error: "Server Error", 
        message: err.message, 
        stack: err.stack 
      }, 500);
    }
  }
};
