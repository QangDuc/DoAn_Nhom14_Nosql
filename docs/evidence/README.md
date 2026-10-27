# Thư mục evidence/

Chứa ảnh chụp thật dùng để thay các hình minh họa chương 4 trong báo cáo Word.

## Quy tắc đặt tên
fig4_1.png … fig4_12.png, đúng như `manifest.md`. Chữ thường, đuôi .png.

## Quy tắc chụp
- PNG, chiều rộng ≥ 1600 px, không JPEG.
- Tắt Snipping Tool, thông báo Windows, tab trình duyệt không liên quan trước khi chụp.
- Chụp khi hai badge là `real`.
- Không vẽ thêm khung đỏ/mũi tên bằng phần mềm ngoài.
- TUYỆT ĐỐI không để lộ: địa chỉ kết nối neo4j+s://, rediss://, mật khẩu, token Bearer, ADMIN_DEMO_PASSWORD. Che trước khi lưu. Nếu đã lộ: tạo lại mật khẩu trong console Aura/Upstash.

## Trình tự chụp (ít lần đặt lại dữ liệu nhất, tiết kiệm lệnh Upstash)
1. Bấm "Đặt lại dữ liệu mẫu" → chụp fig4_1, fig4_2, fig4_3, fig4_9, fig4_10, fig4_11, fig4_12.
2. Mô phỏng 5 lần sai ACC025 → chụp fig4_8 (và fig4_7 nếu có phiên).
3. Chuyển sang "Ngăn chặn chủ động", chạy ACC030→031→032→030 → chụp fig4_6 ở bước 3.
4. Tab Phân tích sâu: "Nạp dữ liệu mẫu" → chụp fig4_5.
5. Tạo ACC040→041→042→043→040, minLen=4 → chụp fig4_4.
6. Bấm "Đặt lại dữ liệu mẫu" lần cuối; đối chiếu 50 / 114 / 3.

## Kiểm tra trước khi đưa cho agent
    python3 check_evidence.py
Báo file thiếu, ảnh quá nhỏ, ảnh gần như trắng; nếu máy có tesseract thì quét chuỗi nhạy cảm.

## Đoạn dán vào prompt sửa docx
Ảnh minh chứng nằm ở evidence/ (fig4_1.png ... fig4_12.png) kèm evidence/manifest.md (tên file, số hình, chú thích, ngày chụp). Thay đúng ảnh cho hình có số tương ứng ở chương 4 (giữ chú thích Caption với trường SEQ); chèn fig4_10..fig4_12 thành Hình 4.10–4.12 cuối chương 4; ảnh nào chưa có thì giữ ảnh cũ và đánh dấu "[CẦN ẢNH CHỤP THẬT]". Chiều rộng hiển thị 15–16 cm, căn giữa; không tạo hay chỉnh sửa ảnh bằng mã. Trước khi chèn, kiểm tra từng ảnh không chứa chuỗi giống địa chỉ kết nối, mật khẩu, token (neo4j+s://, rediss://, password, Bearer) bằng OCR nếu có công cụ; ảnh nghi vấn thì báo cáo, không chèn.
