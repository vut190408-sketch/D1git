// Cấu hình CORS mở toang cho phép mọi nguồn (local, web, APK) truy cập
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export default {
  async fetch(request, env, ctx) {
    // 1. XỬ LÝ CORS PREFLIGHT (Bắt buộc cho Local/APK)
    // Khi ứng dụng gửi yêu cầu OPTIONS trước khi gửi yêu cầu chính
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    // 2. KIỂM TRA BẢO MẬT IP
    if (env.ENABLE_SECURITY === "true" || env.ENABLE_SECURITY === true) {
      const clientIP = request.headers.get("CF-Connecting-IP");
      const allowedIPsList = env.ALLOWED_IPS.split(",").map(ip => ip.trim());
      
      if (!allowedIPsList.includes(clientIP)) {
        return new Response(JSON.stringify({ error: "Truy cập bị từ chối: IP không hợp lệ." }), { 
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
    }

    // 3. XỬ LÝ LÔ-GIC CHÍNH (Kết nối D1)
    try {
      // (Test kết nối) Bạn có thể thay bằng các lệnh gọi env.DB.prepare(...) sau này
      const testData = {
        message: "CORS đã mở, bảo mật IP đang tắt. Kết nối Local/APK thành công!",
        status: "success"
      };

      // Luôn nhớ đính kèm corsHeaders vào Response chính
      return new Response(JSON.stringify(testData), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });

    } catch (error) {
      return new Response(JSON.stringify({ error: "Lỗi Server: " + error.message }), { 
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  }
};
