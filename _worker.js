export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Admin-Token",
    };

    if (method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // 1. ĐĂNG KÝ (Bổ sung Tên hiển thị)
      if (path === "/api/register" && method === "POST") {
        const { user_id, username, password, display_name } = await request.json();
        if (!user_id || !username || !password) {
          return new Response(JSON.stringify({ error: "Thiếu thông tin đăng ký!" }), { status: 400, headers: corsHeaders });
        }
        const name = display_name || username; // Nếu không nhập tên, lấy username làm tên
        await env.DB.prepare("INSERT INTO users (user_id, username, password, display_name) VALUES (?, ?, ?, ?)").bind(user_id, username, password, name).run();
        return new Response(JSON.stringify({ success: true, message: "Đăng ký thành công!" }), { headers: corsHeaders });
      }

      // 2. ĐĂNG NHẬP
      if (path === "/api/login" && method === "POST") {
        const { username, password } = await request.json();
        const user = await env.DB.prepare("SELECT user_id, username, display_name FROM users WHERE username = ? AND password = ?").bind(username, password).first();
        if (!user) return new Response(JSON.stringify({ error: "Sai tài khoản hoặc mật khẩu!" }), { status: 401, headers: corsHeaders });
        return new Response(JSON.stringify({ success: true, user }), { headers: corsHeaders });
      }

      // 3. CẬP NHẬT THÔNG TIN CÁ NHÂN (Đổi Tên)
      if (path === "/api/user/profile" && method === "PUT") {
        const { user_id, display_name } = await request.json();
        if (!user_id || !display_name) return new Response(JSON.stringify({ error: "Thiếu thông tin!" }), { status: 400, headers: corsHeaders });
        await env.DB.prepare("UPDATE users SET display_name = ? WHERE user_id = ?").bind(display_name, user_id).run();
        return new Response(JSON.stringify({ success: true, message: "Cập nhật tên thành công!" }), { headers: corsHeaders });
      }

      // 4. ĐỔI MẬT KHẨU
      if (path === "/api/change-password" && method === "POST") {
        const { user_id, old_password, new_password } = await request.json();
        const user = await env.DB.prepare("SELECT user_id FROM users WHERE user_id = ? AND password = ?").bind(user_id, old_password).first();
        if (!user) return new Response(JSON.stringify({ error: "Mật khẩu cũ không chính xác!" }), { status: 400, headers: corsHeaders });
        await env.DB.prepare("UPDATE users SET password = ? WHERE user_id = ?").bind(new_password, user_id).run();
        return new Response(JSON.stringify({ success: true, message: "Đổi mật khẩu thành công!" }), { headers: corsHeaders });
      }

      // 5. NỘP BÀI THI (Bổ sung quiz_id)
      if (path === "/api/quiz/submit" && method === "POST") {
        const { user_id, quiz_id, correct_count, incorrect_count, correct_question_ids, incorrect_question_ids, start_time, end_time, is_early_submission } = await request.json();
        if (!quiz_id) return new Response(JSON.stringify({ error: "Thiếu ID bài thi (quiz_id)!" }), { status: 400, headers: corsHeaders });
        
        await env.DB.prepare(`
          INSERT INTO quiz_results (user_id, quiz_id, correct_count, incorrect_count, correct_question_ids, incorrect_question_ids, start_time, end_time, is_early_submission) 
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(user_id, quiz_id, correct_count, incorrect_count, correct_question_ids, incorrect_question_ids, start_time, end_time, is_early_submission ? 1 : 0).run();
        return new Response(JSON.stringify({ success: true, message: "Lưu kết quả thành công!" }), { headers: corsHeaders });
      }

      // 6. LỊCH SỬ THI CỦA CÁ NHÂN (GET /api/user/history?user_id=...)
      if (path === "/api/user/history" && method === "GET") {
        const userId = url.searchParams.get("user_id");
        if (!userId) return new Response(JSON.stringify({ error: "Thiếu user_id!" }), { status: 400, headers: corsHeaders });
        const { results } = await env.DB.prepare("SELECT quiz_id, correct_count, incorrect_count, start_time, end_time FROM quiz_results WHERE user_id = ? ORDER BY end_time DESC").bind(userId).all();
        return new Response(JSON.stringify({ success: true, data: results }), { headers: corsHeaders });
      }

      // 7. BẢNG XẾP HẠNG BÀI THI (GET /api/quiz/leaderboard?quiz_id=...)
      if (path === "/api/quiz/leaderboard" && method === "GET") {
        const quizId = url.searchParams.get("quiz_id");
        if (!quizId) return new Response(JSON.stringify({ error: "Thiếu quiz_id!" }), { status: 400, headers: corsHeaders });
        // Xếp hạng: Đúng nhiều nhất lên đầu
        const { results } = await env.DB.prepare(`
          SELECT u.display_name, r.correct_count, r.end_time 
          FROM quiz_results r JOIN users u ON r.user_id = u.user_id 
          WHERE r.quiz_id = ? ORDER BY r.correct_count DESC LIMIT 10
        `).bind(quizId).all();
        return new Response(JSON.stringify({ success: true, data: results }), { headers: corsHeaders });
      }

      // 8. ADMIN BÁO CÁO TOÀN BỘ (Lấy cả quiz_id và tên)
      if (path === "/api/admin/report" && method === "GET") {
        if (request.headers.get("Admin-Token") !== "AdminSieuCap123") {
          return new Response(JSON.stringify({ error: "Từ chối truy cập!" }), { status: 403, headers: corsHeaders });
        }
        const { results } = await env.DB.prepare(`
          SELECT r.result_id, r.quiz_id, u.user_id, u.username, u.display_name, r.correct_count, r.incorrect_count, r.start_time, r.end_time, r.is_early_submission 
          FROM quiz_results r JOIN users u ON r.user_id = u.user_id ORDER BY r.result_id DESC
        `).all();
        return new Response(JSON.stringify({ success: true, data: results }), { headers: corsHeaders });
      }

      return new Response(JSON.stringify({ error: "Đường dẫn không hợp lệ!" }), { status: 404, headers: corsHeaders });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
    }
  }
};
