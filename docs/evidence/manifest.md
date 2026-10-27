# MANIFEST ẢNH MINH CHỨNG – FinGuard Pro (Đề tài 16)

Mỗi dòng = một ảnh chụp thật. Tên file KHÔNG được đổi (agent chèn vào Word dựa vào tên).
Khi chụp xong: đổi `[ ]` thành `[x]`, điền ngày giờ và trạng thái hai badge.

| ✔ | File | Hình | Chú thích (dùng nguyên văn trong Word) | Ảnh phải thấy | Điều kiện chụp | Chụp lúc | Badge Neo4j/Redis |
|---|---|---|---|---|---|---|---|
| [ ] | fig4_1.png | Hình 4.1 | Màn hình Trung tâm Giám sát: chỉ số tổng quan và đồ thị dòng tiền | 4 thẻ KPI (50 tài khoản, 114 giao dịch, 3 chu trình), banner "Phát hiện 3 chu trình luân chuyển khép kín", đồ thị có chu trình đỏ, sidebar hai badge real | Ngay sau "Đặt lại dữ liệu mẫu" | [ĐIỀN] | [ĐIỀN] |
| [ ] | fig4_2.png | Hình 4.2 | Bảng giám sát Lớp bảo vệ xác thực: bộ đếm xác thực thất bại và TTL | ≥ 10 tài khoản, 3 dòng "Đã khóa" kèm TTL đếm ngược, thanh x/5 | Ngay sau reset (bộ đếm hết hạn theo TTL) | [ĐIỀN] | [ĐIỀN] |
| [ ] | fig4_3.png | Hình 4.3 | Chu trình luân chuyển khép kín ACC001 → ACC002 → ACC003 → ACC001 | Một chu trình tô đỏ, nhãn 3 tài khoản, số tiền trên cạnh | Bấm "Zoom chu trình" | [ĐIỀN] | [ĐIỀN] |
| [ ] | fig4_4.png | Hình 4.4 | Rà soát chu trình dài 3–5 đỉnh | Bảng kết quả có ≥ 1 chu trình 4 đỉnh, thời gian truy vấn | Tạo ACC040→041→042→043→040, chọn minLen=4; xong phải đặt lại dữ liệu mẫu | [ĐIỀN] | [ĐIỀN] |
| [ ] | fig4_5.png | Hình 4.5 | Ba mẫu gian lận: chia nhỏ giao dịch, tài khoản trung chuyển, phân tán dòng tiền nhanh | Tab Phân tích sâu với kết quả của ít nhất một mẫu (chụp mỗi mẫu rồi ghép 1 ảnh, hoặc chụp mẫu có kết quả rõ nhất) | Sau "Nạp dữ liệu mẫu"; xong phải đặt lại dữ liệu | [ĐIỀN] | [ĐIỀN] |
| [ ] | fig4_6.png | Hình 4.6 | Giao dịch bị ngăn chặn (HTTP 409) khi khép chu trình ở chế độ Ngăn chặn chủ động | Công tắc ở "Ngăn chặn chủ động", khung kết quả hiện lỗi 409 và đường đi chu trình | Bước 3 của ACC030→031→032→030 | [ĐIỀN] | [ĐIỀN] |
| [ ] | fig4_7.png | Hình 4.7 | Quản lý phiên đăng nhập lưu trên Redis | Danh sách phiên (mã phiên rút gọn, tài khoản, TTL). Nếu giao diện chưa có: chụp key session:* trong Redis Insight, CHE token đầy đủ | Token phải bị che | [ĐIỀN] | [ĐIỀN] |
| [ ] | fig4_8.png | Hình 4.8 | Luồng sự kiện bảo mật thời gian thực (Redis Stream) | Panel "Luồng sự kiện bảo mật" mở rộng, có ≥ 5 sự kiện (xác thực thất bại, phong tỏa…) | Sau khi mô phỏng 5 lần sai ACC025 | [ĐIỀN] | [ĐIỀN] |
| [ ] | fig4_9.png | Hình 4.9 | Hệ thống chạy trên Neo4j và Redis thật (STRICT_DB) | Sidebar hai badge real + kết quả /api/health (neo4j: real, redis: real) | Hai cửa sổ ghép hoặc hai ảnh ghép | [ĐIỀN] | real/real |
| [ ] | fig4_10.png | Hình 4.10 | Đồ thị chu trình trong Neo4j Browser | Truy vấn MATCH chu trình và đồ thị 3 node | KHÔNG để lộ địa chỉ kết nối/mật khẩu | [ĐIỀN] | – |
| [ ] | fig4_11.png | Hình 4.11 | Khóa login:fail và login:lock trên Redis kèm TTL | Danh sách key + TTL (Redis Insight hoặc Data Browser của Upstash) | KHÔNG để lộ địa chỉ kết nối/mật khẩu | [ĐIỀN] | – |
| [ ] | fig4_12.png | Hình 4.12 | Kế hoạch thực thi PROFILE của truy vấn chu trình 3 đỉnh | Thẻ thời gian/DB hits/số dòng + bảng toán tử (cuộn thấy đủ) | Tab Phân tích truy vấn, "Chạy PROFILE" | [ĐIỀN] | [ĐIỀN] |

## Ảnh sẽ KHÔNG nằm trong thư mục này
- Hình 2.1 (kiến trúc) và Hình 5.1 (biểu đồ hiệu năng): sơ đồ/biểu đồ do agent tạo từ BENCHMARK.md, không phải ảnh chụp.
