// ============================================================
//  _worker.js  –  Cloudflare Workers Backend
//  Admin password được đặt qua biến môi trường ADMIN_TOKEN
//  trong wrangler.toml  (mặc định: @admin)
// ============================================================

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    // ── CORS Headers ────────────────────────────────────────
    const cors = {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Admin-Token",
    };

    if (method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    // ── Helpers ─────────────────────────────────────────────
    const res = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { ...cors, "Content-Type": "application/json" },
      });

    // Kiểm tra quyền admin qua header Admin-Token
    const isAdmin = () =>
      request.headers.get("Admin-Token") === env.ADMIN_TOKEN;

    // ============================================================
    try {

      // ══════════════════════════════════════════════════════════
      //  NHÓM 1: NGƯỜI DÙNG – CÔNG KHAI
      // ══════════════════════════════════════════════════════════

      // ── Lấy danh sách tất cả người dùng (ai cũng xem được) ──
      //    Mục đích: HS chọn tên mình rồi nhập mật khẩu cho nhanh
      if (path === "/api/users" && method === "GET") {
        const { results } = await env.DB.prepare(
          `SELECT user_id, username, display_name
           FROM users
           ORDER BY display_name ASC`
        ).all();
        return res({ success: true, data: results });
      }

      // ── Đăng ký tài khoản mới ───────────────────────────────
      if (path === "/api/register" && method === "POST") {
        const { user_id, username, password, display_name } = await request.json();

        if (!user_id || !username || !password) {
          return res({ error: "Thiếu thông tin: cần có user_id, username, password!" }, 400);
        }

        const name = display_name?.trim() || username;

        try {
          await env.DB.prepare(
            `INSERT INTO users (user_id, username, password, display_name)
             VALUES (?, ?, ?, ?)`
          ).bind(user_id, username, password, name).run();
        } catch (e) {
          // SQLite sẽ báo UNIQUE constraint khi trùng user_id hoặc username
          if (e.message.includes("UNIQUE") || e.message.includes("SQLITE_CONSTRAINT")) {
            return res({ error: "Mã học sinh (user_id) hoặc tên đăng nhập đã tồn tại!" }, 409);
          }
          throw e;
        }

        return res({ success: true, message: "Đăng ký thành công!" });
      }

      // ── Đăng nhập ────────────────────────────────────────────
      if (path === "/api/login" && method === "POST") {
        const { username, password } = await request.json();

        const user = await env.DB.prepare(
          `SELECT user_id, username, display_name
           FROM users
           WHERE username = ? AND password = ?`
        ).bind(username, password).first();

        if (!user) {
          return res({ error: "Sai tài khoản hoặc mật khẩu!" }, 401);
        }

        return res({ success: true, user });
      }

      // ── Đổi tên hiển thị ─────────────────────────────────────
      if (path === "/api/user/profile" && method === "PUT") {
        const { user_id, display_name } = await request.json();

        if (!user_id || !display_name?.trim()) {
          return res({ error: "Thiếu user_id hoặc display_name!" }, 400);
        }

        await env.DB.prepare(
          `UPDATE users SET display_name = ? WHERE user_id = ?`
        ).bind(display_name.trim(), user_id).run();

        return res({ success: true, message: "Cập nhật tên thành công!" });
      }

      // ── Đổi mật khẩu ─────────────────────────────────────────
      if (path === "/api/change-password" && method === "POST") {
        const { user_id, old_password, new_password } = await request.json();

        const user = await env.DB.prepare(
          `SELECT user_id FROM users WHERE user_id = ? AND password = ?`
        ).bind(user_id, old_password).first();

        if (!user) {
          return res({ error: "Mật khẩu cũ không chính xác!" }, 400);
        }

        await env.DB.prepare(
          `UPDATE users SET password = ? WHERE user_id = ?`
        ).bind(new_password, user_id).run();

        return res({ success: true, message: "Đổi mật khẩu thành công!" });
      }

      // ══════════════════════════════════════════════════════════
      //  NHÓM 2: THI CỬ – CÔNG KHAI
      // ══════════════════════════════════════════════════════════

      // ── Nộp bài thi ──────────────────────────────────────────
      if (path === "/api/quiz/submit" && method === "POST") {
        const {
          user_id, quiz_id,
          correct_count, incorrect_count,
          correct_question_ids, incorrect_question_ids,
          start_time, end_time,
          is_early_submission,
        } = await request.json();

        if (!user_id || !quiz_id) {
          return res({ error: "Thiếu user_id hoặc quiz_id!" }, 400);
        }

        await env.DB.prepare(`
          INSERT INTO quiz_results
            (user_id, quiz_id, correct_count, incorrect_count,
             correct_question_ids, incorrect_question_ids,
             start_time, end_time, is_early_submission)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          user_id,
          quiz_id,
          correct_count   ?? 0,
          incorrect_count ?? 0,
          correct_question_ids   || "",
          incorrect_question_ids || "",
          start_time,
          end_time,
          is_early_submission ? 1 : 0,
        ).run();

        return res({ success: true, message: "Lưu kết quả thành công!" });
      }

      // ── Lịch sử thi cá nhân ──────────────────────────────────
      //    GET /api/user/history?user_id=SV001
      if (path === "/api/user/history" && method === "GET") {
        const userId = url.searchParams.get("user_id");
        if (!userId) return res({ error: "Thiếu user_id!" }, 400);

        const { results } = await env.DB.prepare(
          `SELECT quiz_id, correct_count, incorrect_count, start_time, end_time
           FROM quiz_results
           WHERE user_id = ?
           ORDER BY end_time DESC`
        ).bind(userId).all();

        return res({ success: true, data: results });
      }

      // ── Bảng xếp hạng theo đề thi ────────────────────────────
      //    GET /api/quiz/leaderboard?quiz_id=DE_THI_TOAN_K10
      if (path === "/api/quiz/leaderboard" && method === "GET") {
        const quizId = url.searchParams.get("quiz_id");
        if (!quizId) return res({ error: "Thiếu quiz_id!" }, 400);

        const { results } = await env.DB.prepare(`
          SELECT u.display_name, r.correct_count, r.end_time
          FROM quiz_results r
          JOIN users u ON r.user_id = u.user_id
          WHERE r.quiz_id = ?
          ORDER BY r.correct_count DESC, r.end_time ASC
          LIMIT 10
        `).bind(quizId).all();

        return res({ success: true, data: results });
      }

      // ══════════════════════════════════════════════════════════
      //  NHÓM 3: CẤU HÌNH ỨNG DỤNG
      // ══════════════════════════════════════════════════════════

      // ── Lấy version + data (ai cũng xem được) ────────────────
      //    App dùng để kiểm tra version có đổi không rồi reload
      //    GET /api/config
      //    GET /api/config?key=version   (chỉ lấy version)
      //    GET /api/config?key=data      (chỉ lấy data)
      if (path === "/api/config" && method === "GET") {
        const key = url.searchParams.get("key");

        if (key) {
          // Chỉ lấy một trường cụ thể
          const row = await env.DB.prepare(
            `SELECT value FROM app_config WHERE key = ?`
          ).bind(key).first();
          return res({ success: true, key, value: row?.value ?? null });
        }

        // Lấy cả version lẫn data
        const vRow = await env.DB.prepare(
          `SELECT value FROM app_config WHERE key = 'version'`
        ).first();
        const dRow = await env.DB.prepare(
          `SELECT value FROM app_config WHERE key = 'data'`
        ).first();

        return res({
          success: true,
          version: vRow?.value ?? "1.0.0",
          data:    dRow?.value ?? "{}",
        });
      }

      // ══════════════════════════════════════════════════════════
      //  NHÓM 4: ADMIN – YÊU CẦU Admin-Token
      // ══════════════════════════════════════════════════════════

      // ── Kiểm tra chung cho tất cả route /api/admin/* ─────────
      if (path.startsWith("/api/admin/") && !isAdmin()) {
        return res({ error: "Từ chối truy cập! Cần Admin-Token hợp lệ." }, 403);
      }

      // ── Admin: Xem báo cáo toàn bộ kết quả ───────────────────
      if (path === "/api/admin/report" && method === "GET") {
        const { results } = await env.DB.prepare(`
          SELECT r.result_id, r.quiz_id,
                 u.user_id, u.username, u.display_name,
                 r.correct_count, r.incorrect_count,
                 r.start_time, r.end_time, r.is_early_submission
          FROM quiz_results r
          JOIN users u ON r.user_id = u.user_id
          ORDER BY r.result_id DESC
        `).all();
        return res({ success: true, data: results });
      }

      // ── Admin: Cập nhật version hoặc data ────────────────────
      //    PUT /api/admin/config
      //    Body: { "version": "1.0.1" }          ← chỉ đổi version
      //    Body: { "data": "{...}" }              ← chỉ đổi data
      //    Body: { "version": "1.0.1", "data": "{...}" }  ← cả hai
      if (path === "/api/admin/config" && method === "PUT") {
        const body = await request.json();
        let updated = [];

        if (body.version !== undefined) {
          await env.DB.prepare(
            `UPDATE app_config SET value = ? WHERE key = 'version'`
          ).bind(String(body.version)).run();
          updated.push("version");
        }

        if (body.data !== undefined) {
          const dataStr = typeof body.data === "string"
            ? body.data
            : JSON.stringify(body.data);
          await env.DB.prepare(
            `UPDATE app_config SET value = ? WHERE key = 'data'`
          ).bind(dataStr).run();
          updated.push("data");
        }

        if (updated.length === 0) {
          return res({ error: "Không có trường nào để cập nhật (cần version hoặc data)!" }, 400);
        }

        return res({ success: true, message: `Đã cập nhật: ${updated.join(", ")}` });
      }

      // ── Admin: Xóa một người dùng cụ thể (FK-safe) ───────────
      //    DELETE /api/admin/delete-user
      //    Body: { "user_id": "SV001" }
      if (path === "/api/admin/delete-user" && method === "DELETE") {
        const { user_id } = await request.json();
        if (!user_id) return res({ error: "Thiếu user_id!" }, 400);

        // Xóa kết quả thi của user này trước (tránh lỗi FK)
        await env.DB.prepare(
          `DELETE FROM quiz_results WHERE user_id = ?`
        ).bind(user_id).run();

        // Sau đó mới xóa user
        await env.DB.prepare(
          `DELETE FROM users WHERE user_id = ?`
        ).bind(user_id).run();

        return res({
          success: true,
          message: `Đã xóa người dùng "${user_id}" và toàn bộ kết quả thi của họ!`,
        });
      }

      // ── Admin: Xóa toàn bộ dữ liệu (FK-safe) ─────────────────
      //    DELETE /api/admin/delete-all
      //    Body: { "confirm": "XOA-TAT-CA" }   ← bắt buộc để tránh xóa nhầm
      if (path === "/api/admin/delete-all" && method === "DELETE") {
        const body = await request.json().catch(() => ({}));

        if (body.confirm !== "XOA-TAT-CA") {
          return res({
            error: 'Cần xác nhận: gửi body { "confirm": "XOA-TAT-CA" } để tiếp tục!',
          }, 400);
        }

        // Xóa FK (quiz_results) trước, rồi mới xóa PK (users)
        const { meta: m1 } = await env.DB.prepare(`DELETE FROM quiz_results`).run();
        const { meta: m2 } = await env.DB.prepare(`DELETE FROM users`).run();

        return res({
          success: true,
          message: `Đã xóa toàn bộ! (${m1.changes ?? "?"} kết quả thi, ${m2.changes ?? "?"} người dùng)`,
        });
      }

      // ── Không khớp route nào ──────────────────────────────────
      return res({ error: "Đường dẫn không hợp lệ!" }, 404);

    } catch (err) {
      return res({ error: err.message }, 500);
    }
  },
};
