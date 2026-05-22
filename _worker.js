export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;
    const origin = request.headers.get("Origin");

    // ==========================================
    // XỬ LÝ BẢO MẬT & CORS DỰA TRÊN wrangler.toml
    // ==========================================
    let allowOrigin = "*";
    const isSecurityEnabled = env.ENABLE_SECURITY === "true";

    if (isSecurityEnabled && origin) {
      const allowedList = (env.ALLOWED_ORIGINS || "").split(",").map(o => o.trim());
      
      // Nếu có Origin gửi lên nhưng không nằm trong danh sách tin cậy -> Chặn ngay lập tức
      if (!allowedList.includes(origin)) {
        return new Response(JSON.stringify({ error: "Truy cập bị từ chối. Nguồn (Origin) không hợp lệ." }), { 
          status: 403, 
          headers: { "Content-Type": "application/json" } 
        });
      }
      allowOrigin = origin; // Chỉ cho phép đúng nguồn tin cậy
    }

    // Header dùng chung để chống lỗi CORS
    const corsHeaders = {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Username, X-Password",
    };

    // Phản hồi ngay cho các truy vấn kiểm tra (Preflight OPTIONS) của trình duyệt
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
      // ----------------------------------------------------
      // [1] LẤY DANH SÁCH USER (Để hiện tên, chỉ cần nhập mật khẩu)
      // ----------------------------------------------------
      if (url.pathname === "/api/users" && method === "GET") {
        const { results } = await env.DB.prepare(
          "SELECT ten_dang_nhap, ten_nguoi_dung FROM nguoi_dung"
        ).all();
        return jsonRes(results);
      }

      // ----------------------------------------------------
      // [2] ĐĂNG KÝ (Cần đủ 3 thông tin)
      // ----------------------------------------------------
      if (url.pathname === "/api/register" && method === "POST") {
        const { ten_dang_nhap, ten_nguoi_dung, mat_khau } = await request.json();
        if (!ten_dang_nhap || !ten_nguoi_dung || !mat_khau) {
          return jsonRes({ error: "Bắt buộc nhập đủ: Tên đăng nhập, Tên hiển thị và Mật khẩu." }, 400);
        }
        
        try {
          await env.DB.prepare(
            "INSERT INTO nguoi_dung (ten_dang_nhap, ten_nguoi_dung, mat_khau) VALUES (?, ?, ?)"
          ).bind(ten_dang_nhap, ten_nguoi_dung, mat_khau).run();
          return jsonRes({ success: true, message: "Đăng ký thành công." });
        } catch (e) {
          return jsonRes({ error: "Tên đăng nhập đã tồn tại!" }, 400);
        }
      }

      // ----------------------------------------------------
      // [3] ĐĂNG NHẬP (Cần 2 thông tin)
      // ----------------------------------------------------
      if (url.pathname === "/api/login" && method === "POST") {
        const { ten_dang_nhap, mat_khau } = await request.json();
        const user = await env.DB.prepare(
          "SELECT ten_nguoi_dung, quyen FROM nguoi_dung WHERE ten_dang_nhap = ? AND mat_khau = ?"
        ).bind(ten_dang_nhap, mat_khau).first();

        if (!user) {
          return jsonRes({ error: "Sai mật khẩu hoặc tên đăng nhập!" }, 401);
        }
        return jsonRes({ success: true, user });
      }

      // ----------------------------------------------------
      // [4] LẤY DỮ LIỆU CÂU HỎI (Ai cũng xem được)
      // ----------------------------------------------------
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

      // ----------------------------------------------------
      // [5] LƯU DỮ LIỆU CÂU HỎI (Chỉ dành cho ADMIN có quyền ALL)
      // ----------------------------------------------------
      if (url.pathname === "/api/data" && (method === "POST" || method === "PUT")) {
        // Lấy tài khoản admin gửi kèm qua Header từ frontend
        const inputUser = request.headers.get("X-Username");
        const inputPass = request.headers.get("X-Password");

        // Xác thực Admin quyền ALL
        const checkAdmin = await env.DB.prepare(
          "SELECT quyen FROM nguoi_dung WHERE ten_dang_nhap = ? AND mat_khau = ? AND quyen = 'ALL'"
        ).bind(inputUser, inputPass).first();

        if (!checkAdmin) {
          return jsonRes({ error: "Từ chối! Chỉ Admin mới có quyền lưu cấu hình này." }, 403);
        }

        const body = await request.json();
        const dataStr = typeof body.data === "string" ? body.data : JSON.stringify(body.data);
        
        // --- QUẢN LÝ VERSION CHÍNH XÁC YÊU CẦU ---
        // Lấy lại version cũ để dự phòng trường hợp admin không muốn đổi version
        const oldRecord = await env.DB.prepare(
          "SELECT version FROM cau_hoi ORDER BY id_cau_hoi DESC LIMIT 1"
        ).first();
        const currentVersion = oldRecord ? oldRecord.version : 1;

        // Chỉ thay đổi version khi Admin CỐ TÌNH truyền biến version lên, nếu không thì dùng version cũ.
        // Tuyệt đối không tự sinh ra bằng code.
        const newVersion = (body.version !== undefined && body.version !== null) ? body.version : currentVersion;

        // Lưu vào DB
        await env.DB.prepare(
          "INSERT INTO cau_hoi (data, version) VALUES (?, ?)"
        ).bind(dataStr, newVersion).run();

        return jsonRes({ 
          success: true, 
          message: "Lưu dữ liệu thành công!", 
          version: newVersion 
        });
      }

      return jsonRes({ error: "Đường dẫn không tồn tại" }, 404);

    } catch (error) {
      return jsonRes({ error: "Lỗi hệ thống: " + error.message }, 500);
    }
  }
};
