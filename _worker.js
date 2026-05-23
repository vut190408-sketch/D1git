// ============================================================
//  _worker.js  v3  –  Cloudflare Workers + D1
//
//  Worker chỉ INSERT dữ liệu thô.
//  DB tự tính qua trigger:
//    tr_grade_answer   → is_correct + correct_option_ids mỗi câu
//    tr_compute_result → quiz_results khi nộp/hết giờ
//    tr_expire_stale   → dọn bài open rác cùng user/quiz
//
//  ROUTES
//  ──────────────────────────────────────────────────────────
//  PUBLIC
//    GET  /api/users
//    POST /api/register
//    POST /api/login
//    PUT  /api/user/profile
//    POST /api/change-password
//    GET  /api/config
//
//  QUIZ
//    GET  /api/quiz/questions?quiz_id=        ← lấy đề (ẩn is_correct)
//    POST /api/quiz/start                     ← bắt đầu làm
//    POST /api/quiz/submit                    ← nộp bài
//    GET  /api/quiz/result?submission_id=     ← kết quả tổng hợp
//    GET  /api/quiz/review?submission_id=     ← chi tiết đúng/sai từng câu
//    GET  /api/quiz/leaderboard?quiz_id=
//    GET  /api/user/history?user_id=
//
//  ADMIN (cần header Admin-Token)
//    GET  /api/admin/report
//    GET  /api/admin/review?submission_id=    ← review đầy đủ (có đáp án đúng)
//    PUT  /api/admin/upload-quiz              ← upload/cập nhật đề thi
//    PUT  /api/admin/config
//    GET  /api/admin/cleanup                  ← xoá bài open rác quá hạn
//    DELETE /api/admin/delete-user
//    DELETE /api/admin/delete-all
// ============================================================

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    const cors = {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Admin-Token",
    };
    if (method === "OPTIONS") return new Response(null, { headers: cors });

    const res = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status, headers: { ...cors, "Content-Type": "application/json" },
      });

    const isAdmin = () =>
      request.headers.get("Admin-Token") === env.ADMIN_TOKEN;

    // ── Parse cây câu hỏi JSON → hàng bảng chuẩn hoá ──────────
    function flattenQuestions(list, quizId, parentId = null, order = { v: 0 }) {
      const qRows = [];
      const oRows = [];
      for (const q of list) {
        qRows.push({
          question_id: q.id,
          quiz_id:     quizId,
          parent_id:   parentId,
          type:        q.type ?? "multiple_choice",
          content:     q.cau_hoi ?? "",
          material:    q.materials ? JSON.stringify(q.materials) : null,
          sort_order:  order.v++,
        });
        for (let i = 0; i < (q.options ?? []).length; i++) {
          const opt = q.options[i];
          oRows.push({
            option_id:   opt.id,
            question_id: q.id,
            content:     opt.content ?? "",
            is_correct:  (q.correctAnswers ?? []).includes(opt.id) ? 1 : 0,
            sort_order:  i,
          });
        }
        if (Array.isArray(q.subQuestions) && q.subQuestions.length) {
          const child = flattenQuestions(q.subQuestions, quizId, q.id, order);
          qRows.push(...child.qRows);
          oRows.push(...child.oRows);
        }
      }
      return { qRows, oRows };
    }

    try {

      // ══════════════════════════════════════════════════════
      //  NHÓM 1: NGƯỜI DÙNG
      // ══════════════════════════════════════════════════════

      if (path === "/api/users" && method === "GET") {
        const { results } = await env.DB.prepare(
          `SELECT user_id, username, display_name FROM users ORDER BY display_name`
        ).all();
        return res({ success: true, data: results });
      }

      if (path === "/api/register" && method === "POST") {
        const { user_id, username, password, display_name } = await request.json();
        if (!user_id || !username || !password)
          return res({ error: "Thiếu user_id, username hoặc password!" }, 400);
        try {
          await env.DB.prepare(
            `INSERT INTO users (user_id, username, password, display_name) VALUES (?,?,?,?)`
          ).bind(user_id, username, password, display_name?.trim() || username).run();
        } catch (e) {
          if (e.message.includes("UNIQUE") || e.message.includes("SQLITE_CONSTRAINT"))
            return res({ error: "Mã học sinh hoặc tên đăng nhập đã tồn tại!" }, 409);
          throw e;
        }
        return res({ success: true, message: "Đăng ký thành công!" });
      }

      if (path === "/api/login" && method === "POST") {
        const { username, password } = await request.json();
        const user = await env.DB.prepare(
          `SELECT user_id, username, display_name FROM users WHERE username=? AND password=?`
        ).bind(username, password).first();
        if (!user) return res({ error: "Sai tài khoản hoặc mật khẩu!" }, 401);
        return res({ success: true, user });
      }

      if (path === "/api/user/profile" && method === "PUT") {
        const { user_id, display_name } = await request.json();
        if (!user_id || !display_name?.trim())
          return res({ error: "Thiếu user_id hoặc display_name!" }, 400);
        await env.DB.prepare(`UPDATE users SET display_name=? WHERE user_id=?`)
          .bind(display_name.trim(), user_id).run();
        return res({ success: true, message: "Cập nhật tên thành công!" });
      }

      if (path === "/api/change-password" && method === "POST") {
        const { user_id, old_password, new_password } = await request.json();
        const user = await env.DB.prepare(
          `SELECT user_id FROM users WHERE user_id=? AND password=?`
        ).bind(user_id, old_password).first();
        if (!user) return res({ error: "Mật khẩu cũ không chính xác!" }, 400);
        await env.DB.prepare(`UPDATE users SET password=? WHERE user_id=?`)
          .bind(new_password, user_id).run();
        return res({ success: true, message: "Đổi mật khẩu thành công!" });
      }

      // ══════════════════════════════════════════════════════
      //  NHÓM 2: THI CỬ
      // ══════════════════════════════════════════════════════

      // GET /api/quiz/questions?quiz_id=DE001
      // Trả về đề thi cho học sinh – ẩn is_correct
      if (path === "/api/quiz/questions" && method === "GET") {
        const quizId = url.searchParams.get("quiz_id");
        if (!quizId) return res({ error: "Thiếu quiz_id!" }, 400);

        const { results: qs } = await env.DB.prepare(`
          SELECT question_id, parent_id, type, content, material, sort_order
          FROM questions WHERE quiz_id=? ORDER BY sort_order
        `).bind(quizId).all();

        if (!qs.length) return res({ error: "Không tìm thấy đề thi!" }, 404);

        const { results: opts } = await env.DB.prepare(`
          SELECT o.option_id, o.question_id, o.content, o.sort_order
          FROM question_options o
          JOIN questions q ON o.question_id = q.question_id
          WHERE q.quiz_id=? ORDER BY o.sort_order
        `).bind(quizId).all();

        // Gộp options vào từng câu hỏi
        const optMap = {};
        for (const o of opts) {
          if (!optMap[o.question_id]) optMap[o.question_id] = [];
          optMap[o.question_id].push({ id: o.option_id, content: o.content });
        }
        const data = qs.map(q => ({
          ...q,
          material: q.material ? JSON.parse(q.material) : null,
          options:  optMap[q.question_id] ?? [],
        }));

        return res({ success: true, data });
      }

      // POST /api/quiz/start
      // Body: { user_id, quiz_id, start_time }
      // Trả về: { submission_id }
      if (path === "/api/quiz/start" && method === "POST") {
        const { user_id, quiz_id, start_time } = await request.json();
        if (!user_id || !quiz_id || !start_time)
          return res({ error: "Thiếu user_id, quiz_id hoặc start_time!" }, 400);

        // Kiểm tra đề thi tồn tại
        const quizExists = await env.DB.prepare(
          `SELECT 1 FROM questions WHERE quiz_id=? LIMIT 1`
        ).bind(quiz_id).first();
        if (!quizExists) return res({ error: "Đề thi không tồn tại!" }, 404);

        const { meta } = await env.DB.prepare(
          `INSERT INTO submissions (user_id, quiz_id, start_time) VALUES (?,?,?)`
        ).bind(user_id, quiz_id, start_time).run();

        return res({ success: true, submission_id: meta.last_row_id });
      }

      // POST /api/quiz/submit
      // Client gửi: { submission_id, end_time, answers: { "q_id": ["opt_a",...] } }
      // DB trigger tự tính is_correct + correct_option_ids + quiz_results
      if (path === "/api/quiz/submit" && method === "POST") {
        const { submission_id, end_time, answers } = await request.json();
        if (!submission_id || !end_time || !answers)
          return res({ error: "Thiếu submission_id, end_time hoặc answers!" }, 400);

        const sub = await env.DB.prepare(
          `SELECT submission_id, quiz_id, status FROM submissions WHERE submission_id=?`
        ).bind(submission_id).first();
        if (!sub)
          return res({ error: "Không tìm thấy submission!" }, 404);
        if (sub.status !== "open")
          return res({ error: "Bài đã nộp hoặc đã hết hạn!" }, 409);

        // Lấy type của từng câu để điền question_type (trigger cần)
        const { results: qtypes } = await env.DB.prepare(
          `SELECT question_id, type FROM questions WHERE quiz_id=?`
        ).bind(sub.quiz_id).all();
        const typeMap = Object.fromEntries(qtypes.map(q => [q.question_id, q.type]));

        // Batch INSERT answers – trigger tr_grade_answer tự chạy mỗi row
        const ansStmts = Object.entries(answers).map(([qId, sel]) =>
          env.DB.prepare(`
            INSERT OR REPLACE INTO submission_answers
              (submission_id, question_id, question_type, selected_ids)
            VALUES (?, ?, ?, ?)
          `).bind(
            submission_id,
            qId,
            typeMap[qId] ?? "multiple_choice",
            JSON.stringify(Array.isArray(sel) ? sel : [sel])
          )
        );

        // Flip status → kích hoạt tr_compute_result
        const closeStmt = env.DB.prepare(
          `UPDATE submissions SET end_time=?, status='submitted' WHERE submission_id=?`
        ).bind(end_time, submission_id);

        await env.DB.batch([...ansStmts, closeStmt]);

        // Đọc lại kết quả DB vừa tính
        const result = await env.DB.prepare(
          `SELECT correct_count, incorrect_count, skipped_count, score, is_early_submission
           FROM quiz_results WHERE submission_id=?`
        ).bind(submission_id).first();

        return res({ success: true, message: "Nộp bài thành công!", result });
      }

      // GET /api/quiz/result?submission_id=5
      // Kết quả tổng hợp (điểm, đúng/sai bao nhiêu câu)
      if (path === "/api/quiz/result" && method === "GET") {
        const sid = url.searchParams.get("submission_id");
        if (!sid) return res({ error: "Thiếu submission_id!" }, 400);

        const result = await env.DB.prepare(`
          SELECT r.*, u.display_name
          FROM quiz_results r JOIN users u ON r.user_id = u.user_id
          WHERE r.submission_id=?
        `).bind(sid).first();
        if (!result) return res({ error: "Chưa có kết quả (bài chưa nộp)!" }, 404);

        return res({ success: true, data: result });
      }

      // GET /api/quiz/review?submission_id=5
      // Chi tiết từng câu: học sinh chọn gì, đáp án đúng là gì, đúng hay sai
      // Dành cho học sinh xem lại bài của mình (KHÔNG lộ is_correct của đề gốc)
      if (path === "/api/quiz/review" && method === "GET") {
        const sid = url.searchParams.get("submission_id");
        if (!sid) return res({ error: "Thiếu submission_id!" }, 400);

        // Kiểm tra submission thuộc về ai (bảo mật: chỉ chủ bài được xem)
        const sub = await env.DB.prepare(
          `SELECT user_id, status FROM submissions WHERE submission_id=?`
        ).bind(sid).first();
        if (!sub) return res({ error: "Không tìm thấy submission!" }, 404);
        if (sub.status === "open")
          return res({ error: "Bài chưa nộp, chưa thể xem kết quả!" }, 403);

        const { results: answers } = await env.DB.prepare(`
          SELECT
            sa.question_id,
            q.content        AS question_content,
            sa.question_type AS type,
            sa.selected_ids,           -- học sinh đã chọn
            sa.correct_option_ids,     -- đáp án đúng (DB điền)
            sa.is_correct,             -- 1=đúng | 0=sai | NULL=không chấm
            -- Options đầy đủ (để render lại giao diện)
            (
              SELECT JSON_GROUP_ARRAY(JSON_OBJECT(
                'id',      o.option_id,
                'content', o.content
              ))
              FROM (
                SELECT option_id, content
                FROM question_options
                WHERE question_id = sa.question_id
                ORDER BY sort_order
              ) o
            ) AS options
          FROM submission_answers sa
          JOIN questions q ON sa.question_id = q.question_id
          WHERE sa.submission_id = ?
          ORDER BY q.sort_order
        `).bind(sid).all();

        // Parse JSON strings → object
        const data = answers.map(row => ({
          question_id:       row.question_id,
          question_content:  row.question_content,
          type:              row.type,
          is_correct:        row.is_correct,   // null | 0 | 1
          selected_ids:      JSON.parse(row.selected_ids      || "[]"),
          correct_option_ids:JSON.parse(row.correct_option_ids|| "[]"),
          options:           JSON.parse(row.options            || "[]"),
        }));

        return res({ success: true, submission_id: Number(sid), data });
      }

      // GET /api/quiz/leaderboard?quiz_id=DE001
      if (path === "/api/quiz/leaderboard" && method === "GET") {
        const quizId = url.searchParams.get("quiz_id");
        if (!quizId) return res({ error: "Thiếu quiz_id!" }, 400);
        const { results } = await env.DB.prepare(`
          SELECT u.display_name, r.correct_count, r.score, r.end_time
          FROM quiz_results r JOIN users u ON r.user_id = u.user_id
          WHERE r.quiz_id=?
          ORDER BY r.score DESC, r.end_time ASC
          LIMIT 20
        `).bind(quizId).all();
        return res({ success: true, data: results });
      }

      // GET /api/user/history?user_id=SV001
      if (path === "/api/user/history" && method === "GET") {
        const userId = url.searchParams.get("user_id");
        if (!userId) return res({ error: "Thiếu user_id!" }, 400);
        const { results } = await env.DB.prepare(`
          SELECT quiz_id, correct_count, incorrect_count, skipped_count,
                 score, start_time, end_time, is_early_submission, submission_id
          FROM quiz_results WHERE user_id=? ORDER BY end_time DESC
        `).bind(userId).all();
        return res({ success: true, data: results });
      }

      // ══════════════════════════════════════════════════════
      //  NHÓM 3: CẤU HÌNH CÔNG KHAI
      // ══════════════════════════════════════════════════════

      if (path === "/api/config" && method === "GET") {
        const key = url.searchParams.get("key");
        if (key) {
          const row = await env.DB.prepare(
            `SELECT value FROM app_config WHERE key=?`
          ).bind(key).first();
          return res({ success: true, key, value: row?.value ?? null });
        }
        const rows = await env.DB.prepare(`SELECT key, value FROM app_config`).all();
        const cfg  = Object.fromEntries(rows.results.map(r => [r.key, r.value]));
        return res({ success: true, config: cfg });
      }

      // ══════════════════════════════════════════════════════
      //  NHÓM 4: ADMIN
      // ══════════════════════════════════════════════════════

      if (path.startsWith("/api/admin/") && !isAdmin())
        return res({ error: "Từ chối truy cập! Cần Admin-Token hợp lệ." }, 403);

      // GET /api/admin/report
      if (path === "/api/admin/report" && method === "GET") {
        const { results } = await env.DB.prepare(`
          SELECT r.result_id, r.submission_id, r.quiz_id,
                 u.user_id, u.username, u.display_name,
                 r.correct_count, r.incorrect_count, r.skipped_count, r.score,
                 r.correct_question_ids, r.incorrect_question_ids, r.skipped_question_ids,
                 r.start_time, r.end_time, r.is_early_submission
          FROM quiz_results r JOIN users u ON r.user_id = u.user_id
          ORDER BY r.result_id DESC
        `).all();
        return res({ success: true, data: results });
      }

      // GET /api/admin/review?submission_id=5
      // Giống route học sinh NHƯNG trả thêm is_correct gốc của option (admin thấy đầy đủ)
      if (path === "/api/admin/review" && method === "GET") {
        const sid = url.searchParams.get("submission_id");
        if (!sid) return res({ error: "Thiếu submission_id!" }, 400);

        const meta = await env.DB.prepare(`
          SELECT s.submission_id, s.status, s.start_time, s.end_time,
                 u.user_id, u.display_name, u.username,
                 r.correct_count, r.incorrect_count, r.skipped_count, r.score
          FROM submissions s
          JOIN users u ON s.user_id = u.user_id
          LEFT JOIN quiz_results r ON r.submission_id = s.submission_id
          WHERE s.submission_id=?
        `).bind(sid).first();
        if (!meta) return res({ error: "Không tìm thấy submission!" }, 404);

        const { results: answers } = await env.DB.prepare(`
          SELECT
            sa.question_id,
            q.content        AS question_content,
            sa.question_type AS type,
            sa.selected_ids,
            sa.correct_option_ids,
            sa.is_correct,
            (
              SELECT JSON_GROUP_ARRAY(JSON_OBJECT(
                'id',         o.option_id,
                'content',    o.content,
                'is_correct', o.is_correct   -- admin thấy đáp án đúng rõ ràng
              ))
              FROM (
                SELECT option_id, content, is_correct
                FROM question_options
                WHERE question_id = sa.question_id
                ORDER BY sort_order
              ) o
            ) AS options
          FROM submission_answers sa
          JOIN questions q ON sa.question_id = q.question_id
          WHERE sa.submission_id=?
          ORDER BY q.sort_order
        `).bind(sid).all();

        const data = answers.map(row => ({
          question_id:        row.question_id,
          question_content:   row.question_content,
          type:               row.type,
          is_correct:         row.is_correct,
          selected_ids:       JSON.parse(row.selected_ids       || "[]"),
          correct_option_ids: JSON.parse(row.correct_option_ids || "[]"),
          options:            JSON.parse(row.options             || "[]"),
        }));

        return res({ success: true, meta, data });
      }

      // PUT /api/admin/upload-quiz
      // Body: { quiz_id: "DE001", questions: [...] }
      if (path === "/api/admin/upload-quiz" && method === "PUT") {
        const { quiz_id, questions } = await request.json();
        if (!quiz_id || !Array.isArray(questions) || !questions.length)
          return res({ error: "Thiếu quiz_id hoặc questions!" }, 400);

        // Xoá đề cũ
        await env.DB.batch([
          env.DB.prepare(`DELETE FROM question_options WHERE question_id IN
            (SELECT question_id FROM questions WHERE quiz_id=?)`).bind(quiz_id),
          env.DB.prepare(`DELETE FROM questions WHERE quiz_id=?`).bind(quiz_id),
        ]);

        const { qRows, oRows } = flattenQuestions(questions, quiz_id);

        const qStmts = qRows.map(q => env.DB.prepare(`
          INSERT INTO questions (question_id,quiz_id,parent_id,type,content,material,sort_order)
          VALUES (?,?,?,?,?,?,?)
        `).bind(q.question_id, q.quiz_id, q.parent_id, q.type,
                q.content, q.material, q.sort_order));

        const oStmts = oRows.map(o => env.DB.prepare(`
          INSERT INTO question_options (option_id,question_id,content,is_correct,sort_order)
          VALUES (?,?,?,?,?)
        `).bind(o.option_id, o.question_id, o.content, o.is_correct, o.sort_order));

        await env.DB.batch([...qStmts, ...oStmts]);

        return res({
          success: true,
          message: `Upload thành công! ${qRows.length} câu, ${oRows.length} lựa chọn.`,
          stats: { questions: qRows.length, options: oRows.length },
        });
      }

      // PUT /api/admin/config
      // Body: { version, quiz_minutes, ... }
      if (path === "/api/admin/config" && method === "PUT") {
        const body    = await request.json();
        const allowed = ["version", "quiz_minutes"];
        const updated = [];
        for (const key of allowed) {
          if (body[key] !== undefined) {
            await env.DB.prepare(`
              INSERT INTO app_config (key,value) VALUES (?,?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value
            `).bind(key, String(body[key])).run();
            updated.push(key);
          }
        }
        if (!updated.length)
          return res({ error: `Chỉ cho phép cập nhật: ${allowed.join(", ")}` }, 400);
        return res({ success: true, message: `Đã cập nhật: ${updated.join(", ")}` });
      }

      // GET /api/admin/cleanup
      // Đóng tất cả submissions đang 'open' quá thời gian quiz_minutes
      if (path === "/api/admin/cleanup" && method === "GET") {
        const minRow = await env.DB.prepare(
          `SELECT value FROM app_config WHERE key='quiz_minutes'`
        ).first();
        const minutes = parseInt(minRow?.value ?? "45", 10);

        const { meta } = await env.DB.prepare(`
          UPDATE submissions
          SET status='expired', end_time=DATETIME('now')
          WHERE status='open'
            AND JULIANDAY('now') - JULIANDAY(start_time) > ? / 1440.0
        `).bind(minutes).run();

        return res({
          success: true,
          message: `Đã đóng ${meta.changes ?? 0} bài quá hạn.`,
          expired: meta.changes ?? 0,
        });
      }

      // DELETE /api/admin/delete-user
      if (path === "/api/admin/delete-user" && method === "DELETE") {
        const { user_id } = await request.json();
        if (!user_id) return res({ error: "Thiếu user_id!" }, 400);
        await env.DB.batch([
          env.DB.prepare(`DELETE FROM submission_answers WHERE submission_id IN
            (SELECT submission_id FROM submissions WHERE user_id=?)`).bind(user_id),
          env.DB.prepare(`DELETE FROM quiz_results  WHERE user_id=?`).bind(user_id),
          env.DB.prepare(`DELETE FROM submissions   WHERE user_id=?`).bind(user_id),
          env.DB.prepare(`DELETE FROM users         WHERE user_id=?`).bind(user_id),
        ]);
        return res({ success: true, message: `Đã xóa người dùng "${user_id}"!` });
      }

      // DELETE /api/admin/delete-all
      if (path === "/api/admin/delete-all" && method === "DELETE") {
        const body = await request.json().catch(() => ({}));
        if (body.confirm !== "XOA-TAT-CA")
          return res({ error: 'Cần body { "confirm": "XOA-TAT-CA" }' }, 400);
        await env.DB.batch([
          env.DB.prepare(`DELETE FROM submission_answers`),
          env.DB.prepare(`DELETE FROM quiz_results`),
          env.DB.prepare(`DELETE FROM submissions`),
          env.DB.prepare(`DELETE FROM users`),
        ]);
        return res({ success: true, message: "Đã xoá toàn bộ dữ liệu người dùng!" });
      }

      return res({ error: "Đường dẫn không hợp lệ!" }, 404);

    } catch (err) {
      return res({ error: err.message }, 500);
    }
  },
};
