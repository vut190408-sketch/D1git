export default {
  async fetch(request, env) {
    // Kiểm tra biến môi trường DB đã được liên kết thành công hay chưa
    if (!env.DB) {
      return new Response(JSON.stringify({
        success: false,
        error: "Biến môi trường 'DB' chưa được cấu hình hoặc hệ thống không nhận diện được."
      }), {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    }

    try {
      // Thực hiện truy vấn hệ thống SQLite để lấy danh sách các bảng tự tạo
      const { results } = await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';"
      ).all();

      return new Response(JSON.stringify({
        success: true,
        status: "Kết nối chính xác và thành công!",
        database_tables: results
      }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    } catch (error) {
      return new Response(JSON.stringify({
        success: false,
        error: "Lỗi thực thi truy vấn hoặc sai lệch cấu hình thông số.",
        details: error.message
      }), {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    }
  }
};
