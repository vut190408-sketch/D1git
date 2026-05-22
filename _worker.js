export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;
    const origin = request.headers.get("Origin");

    let allowOrigin = "*";
    const isSecurityEnabled = env.ENABLE_SECURITY === "true";

    if (isSecurityEnabled && origin) {
      const allowedList = (env.ALLOWED_ORIGINS || "").split(",").map(o => o.trim());
      if (!allowedList.includes(origin)) {
        return new Response(JSON.stringify({ error: "Truy cập bị từ chối." }), { 
          status: 403, 
          headers: { "Content-Type": "application/json" } 
        });
      }
      allowOrigin = origin;
    }

    const corsHeaders = {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Username, X-Password",
    };

    if (method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const jsonRes = (data, status = 200) => {
      return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    };

    try {
      // Lấy danh sách thành viên công khai (chỉ hiện tên đăng nhập và tên hiển thị)
      if (url.pathname === "/api/users" && method === "GET") {
        const { results } = await env.DB.prepare(
          "SELECT ten_dang_nhap, ten_nguoi_dung FROM nguoi_dung"
        ).all();
        return jsonRes(results);
      }

      // Đăng ký tài khoản (bắt buộc nhập 3 thông tin)
      if (url.pathname === "/api/register" && method === "POST") {
        const { ten_dang_nhap, ten_nguoi_dung, mat_khau } = await request.json();
        if (!ten_dang_nhap || !ten_nguoi_dung || !mat_khau) {
          return jsonRes({ error: "Bắt buộc nhập đủ 3 thông tin." }, 400);
        }
        try {
          await env.DB.prepare(
            "INSERT INTO nguoi_dung (ten_dang_nhap, ten_nguoi_dung, mat_khau) VALUES (?, ?, ?)"
          ).bind(ten_dang_nhap, ten_nguoi_dung, mat_khau).run();
          return jsonRes({ success: true });
        } catch (e) {
          return jsonRes({ error: "Tên đăng nhập đã tồn tại!" }, 400);
        }
      }

      // Đăng nhập tài khoản (kiểm tra 2 thông tin)
      if (url.pathname === "/api/login" && method === "POST") {
        const { ten_dang_nhap, mat_khau } = await request.json();
        const user = await env.DB.prepare(
          "SELECT ten_nguoi_dung, quyen FROM nguoi_dung WHERE ten_dang_nhap = ? AND mat_khau = ?"
        ).bind(ten_dang_nhap, mat_khau).first();

        if (!user) {
          return jsonRes({ error: "Sai tài khoản hoặc mật khẩu!" }, 401);
        }
        return jsonRes({ success: true, user });
      }

      // Lấy câu hỏi công khai (ai cũng vào xem được)
      if (url.pathname === "/api/data" && method === "GET") {
        const result = await env.DB.prepare(
          "SELECT data, version FROM cau_hoi ORDER BY id_cau_hoi DESC LIMIT 1"
        ).first();
        if (result) {
          return jsonRes({
            version: result.version,
            data: JSON.parse(result.data || "[]")
          });
        }
        return jsonRes({ version: null, data: [] });
      }

      // Lưu câu hỏi (chỉ dành cho Admin có quyền ALL xác thực qua Header)
      if (url.pathname === "/api/data" && (method === "POST" || method === "PUT")) {
        const inputUser = request.headers.get("X-Username");
        const inputPass = request.headers.get("X-Password");

        const checkAdmin = await env.DB.prepare(
          "SELECT quyen FROM nguoi_dung WHERE ten_dang_nhap = ? AND mat_khau = ? AND quyen = 'ALL'"
        ).bind(inputUser, inputPass).first();

        if (!checkAdmin) {
          return jsonRes({ error: "Từ chối truy cập." }, 403);
        }

        const body = await request.json();
        const dataStr = typeof body.data === "string" ? body.data : JSON.stringify(body.data);
        
        // Quản lý version cố định: Lấy bản cũ để giữ nguyên trừ khi có truyền số mới lên công khai
        const oldRecord = await env.DB.prepare(
          "SELECT version FROM cau_hoi ORDER BY id_cau_hoi DESC LIMIT 1"
        ).first();
        const currentVersion = oldRecord ? oldRecord.version : 1;
        const newVersion = (body.version !== undefined && body.version !== null) ? body.version : currentVersion;

        await env.DB.prepare(
          "INSERT INTO cau_hoi (data, version) VALUES (?, ?)"
        ).bind(dataStr, newVersion).run();

        return jsonRes({ success: true, version: newVersion });
      }

      return jsonRes({ error: "Không tìm thấy đường dẫn" }, 404);
    } catch (error) {
      return jsonRes({ error: error.message }, 500);
    }
  }
};
