# HƯỚNG DẪN CHẠY VÀ KỊCH BẢN DEMO BẢO VỆ ĐỒ ÁN
**Đề tài 16 – Phát hiện gian lận giao dịch (Neo4j) và chống tấn công Brute-force (Redis)**

---

## PHẦN 1: KHỞI ĐỘNG HỆ THỐNG TRƯỚC BUỔI BẢO VỆ

### Bước 1: Khởi chạy hạ tầng Docker (Neo4j, Redis, Redis Insight)
```bash
docker compose up -d
```
Đợi khoảng 15–20 giây để Neo4j khởi động hoàn tất. Kiểm tra các cổng giao diện:
- **Dashboard Admin của đồ án**: `http://localhost:3000`
- **Neo4j Browser**: `http://localhost:7474` (User: `neo4j` / Password: `password123`)
- **Redis Insight**: `http://localhost:5540` (Kết nối tới host: `redis`, port: `6379`)

### Bước 2: Cài đặt thư viện và nạp dữ liệu mẫu (Seed)
```bash
cp .env.example .env
npm install
npm run seed
```
Khi chạy `npm run seed`, màn hình console sẽ in ra:
- Đúng **50 tài khoản** (`ACC001` → `ACC050`) có thuộc tính vai trò `role` (`ACC001` mang vai trò `ADMIN`, `ACC002` → `ACC050` mang vai trò `CUSTOMER`). Mật khẩu khách hàng được mã hóa băm bằng `bcrypt`, mật khẩu ADMIN cấu hình qua biến môi trường `ADMIN_DEMO_PASSWORD`.
- **114 giao dịch** `[:TRANSFERRED]`, bao gồm **3 chu trình luân chuyển khép kín** cài sẵn:
  1. `ACC001 → ACC002 → ACC003 → ACC001`
  2. `ACC004 → ACC005 → ACC006 → ACC004`
  3. `ACC007 → ACC008 → ACC009 → ACC007`
- **12 tài khoản trên Redis** có bộ đếm sai (`login:fail:*`), trong đó 3 tài khoản đang bị khóa (`ACC010`, `ACC011`, `ACC012`).

### Bước 3: Chạy Backend + Dashboard
```bash
npm start
```
Mở trình duyệt tại: **`http://localhost:3000`**

---

## PHẦN 2: KỊCH BẢN DEMO TRƯỚC HỘI ĐỒNG (3 KỊCH BẢN TRỌNG TÂM)

### Kịch bản 1: Demo Chống tấn công Brute-force với Redis (`INCR`, `EXPIRE`, `SET ... EX`, `TTL`)
1. **Quan sát trạng thái ban đầu**:
   - Trên **Dashboard (Khối 1)**: Bảng giám sát tự làm mới mỗi 3 giây, hiển thị sẵn các tài khoản đang bị khóa (`ACC010`, `ACC011`, `ACC012`) với thời gian đếm ngược TTL.
   - Mở **Redis Insight (`http://localhost:5540`)**: Lọc theo từ khóa `login:*` để hội đồng thấy các key `login:fail:*` và `login:lock:*`.
2. **Thực hiện tấn công dò mật khẩu vào tài khoản `ACC025`**:
   - Tại **Khối 3A (Demo Đăng nhập)**, nhập tài khoản `ACC025` và mật khẩu sai `SaiMatKhau123`.
   - Bấm **"Thử Đăng Nhập"** lần 1 → Hệ thống trả về HTTP `401`, báo đã sai `1/5` lần (còn 4 lần thử) và đặt TTL `900s` (15 phút) cho key `login:fail:ACC025`.
   - Bấm tiếp lần 2, 3, 4 → Bộ đếm `INCR` trên Khối 1 và trong Redis Insight tăng dần lên `2`, `3`, `4`.
   - Bấm lần thứ 5 → Hệ thống trả về HTTP `429 Too Many Requests`, tự động tạo key `login:lock:ACC025` với giá trị `"locked"` và `EX 300` (khóa 5 phút).
3. **Kiểm chứng chặn đứng khi đang bị khóa & Gỡ khóa tạm thời**:
   - Bấm **"Nhập mật khẩu"** và gõ mật khẩu đúng của tài khoản rồi bấm **"Thử Đăng Nhập"** → Middleware chặn ngay lập tức (HTTP `429`) kèm số giây còn lại (`remainingSeconds`), không cho phép kiểm tra mật khẩu trong Neo4j.
   - Trên **Khối 1**, bấm nút **"Gỡ khóa tạm thời"** tại dòng `ACC025` (hoặc thử đăng nhập lại sau khi gỡ khóa tạm thời) → Đăng nhập thành công, key `login:fail:ACC025` bị xóa bằng lệnh `DEL`, đồng thời sinh key `session:{token}` trong Redis chứa JSON `{ accountId, role, createdAt }`.

---

### Kịch bản 2: Giao dịch chuyển tiền 2 bước (Initiate & Confirm OTP) và kiểm soát chu trình ACID
1. **Quy trình 2 bước với mã OTP bảo mật**:
   - **Bước 1 (Initiate)**: Gửi request `POST /api/transactions/initiate` với `{ fromAccountId, toAccountId, amount, note }`. Redis lưu trạng thái giao dịch chờ vào Hash `otp:{txRef}` (`fromAccountId`, `toAccountId`, `amount`, `note`, `otp`) với `TTL 60s`.
   - **Bước 2 (Confirm)**: Gửi request `POST /api/transactions/confirm` với `{ txRef, otp }`. Bộ đếm `otp:attempts:{txRef}` tự động `INCR` và đặt `EXPIRE 60` (tối đa 3 lần thử). Khi xác thực OTP thành công, Redis gọi `DEL otp:{txRef}` để giành quyền xử lý nguyên tử và thực thi giao dịch ACID trên Neo4j.
2. **Khóa ghi tạm thời và giao dịch toàn vẹn ACID trong Neo4j**:
   - Trong quá trình thực hiện giao dịch, khóa ghi tạm `SET from._txLock = $timestamp` được gán trên node nguồn để bảo vệ số dư.
   - Kiểm tra lại trạng thái tài khoản và số dư thực tế trong cùng session ACID write transaction.
   - Sau khi trừ tiền node gửi, cộng tiền node nhận, truy vấn Cypher tự động `REMOVE from._txLock` và tạo cạnh `[:TRANSFERRED]`.
3. **Mô phỏng chu trình luân chuyển khép kín qua Form / API**:
   - Sử dụng 3 bước chuyển tiền giữa `ACC030 → ACC031 → ACC032 → ACC030`.
   - Ngay trong JSON phản hồi của giao dịch khép vòng thứ 3, cờ `"fraudAlert": true` bật sáng kèm thông báo phát hiện chu trình `ACC032 → ACC030 → ACC031 → ACC032`!

---

### Kịch bản 3: Rà soát và trực quan hóa Chu trình luân chuyển khép kín trên Đồ thị (vis-network & Neo4j Browser)
1. **Trên Dashboard (Khối 2)**:
   - Ngay sau Bước 3 ở trên (hoặc khi bấm nút **"🔍 Rà soát chu trình nghi vấn"**), **Banner Cảnh Báo Đỏ** hiển thị tổng cộng **4 chu trình** (3 chu trình gốc + 1 chu trình mới `ACC030 → ACC031 → ACC032 → ACC030`).
   - Bấm nút **"Zoom Chu Trình"** bên cạnh chu trình `ACC030 → ACC031 → ACC032 → ACC030` hoặc chuyển chế độ hiển thị sang **"Chỉ hiển thị các Node/Cạnh thuộc Chu trình ĐỎ"** để hội đồng nhìn rõ 4 tam giác luân chuyển khép kín màu đỏ rực trên nền đồ thị.
2. **Đối chiếu trực tiếp trên Neo4j Browser (`http://localhost:7474`)**:
   - Dán câu lệnh Cypher sau vào Neo4j Browser để hiển thị đồ thị các chu trình luân chuyển khép kín nghi vấn:
   ```cypher
   MATCH path = (a:Account)-[r1:TRANSFERRED]->(b:Account)-[r2:TRANSFERRED]->(c:Account)-[r3:TRANSFERRED]->(a)
   WHERE a.accountId < b.accountId AND a.accountId < c.accountId AND b.accountId <> c.accountId
   RETURN path
   ```

---

## PHẦN 3: CHECKLIST KIỂM THỬ NGHIỆM THU (PASS / FAIL)

| STT | Hạng mục kiểm thử | Kỳ vọng nghiệm thu | Kết quả |
| :--- | :--- | :--- | :---: |
| 1 | Hạ tầng Docker Compose | Khởi chạy thành công 3 container: `neo4j`, `redis`, `redis-insight`, đọc cấu hình từ `.env`. | **PASS** |
| 2 | Constraint & Index Neo4j | Tạo UNIQUE constraint trên `Account(accountId)` và Index trên `TRANSFERRED(txId, timestamp)`. | **PASS** |
| 3 | Dữ liệu Seed Neo4j | Đúng 50 Account (`ACC001`..`ACC050`), 114 giao dịch, đúng 3 chu trình cài sẵn, không phát sinh chu trình ngẫu nhiên. | **PASS** |
| 4 | Dữ liệu Seed Redis | Có 12 tài khoản mang key `login:fail:*` (1–5 lần) và 3 tài khoản đang khóa `login:lock:*` có TTL. | **PASS** |
| 5 | Giao dịch toàn vẹn (ACID) Neo4j | Chuyển tiền gồm 2 bước (initiate & confirm), kiểm tra số dư và trạng thái trong transaction ACID của Neo4j với khóa ghi tạm `_txLock` được gỡ bỏ ngay trong cùng giao dịch (`REMOVE from._txLock`). | **PASS** |
| 6 | Chống Brute-force Redis | Sai 1–4 lần tăng `INCR` + đặt `EXPIRE`; sai lần 5 tạo `login:lock:{id}` với `EX 300`; đang khóa trả HTTP `429` kèm TTL. | **PASS** |
| 7 | Xác thực OTP & Quản lý phiên | Cấu trúc phiên `session:{token}` lưu JSON `{ accountId, role, createdAt }`. Trạng thái chờ lưu Hash `otp:{txRef}` (TTL 60s), bộ đếm `otp:attempts:{txRef}` (tối đa 3 lần). Giành quyền nguyên tử qua `DEL otp:{txRef}`. | **PASS** |
| 8 | Phát hiện chu trình Cypher | Truy vấn `(a)->(b)->(c)->(a)` loại bỏ trùng lặp xoay vòng (`a < b AND a < c`), lọc theo thời gian & số tiền tối thiểu. | **PASS** |
| 9 | Dashboard trực quan & Phân quyền | Hỗ trợ 2 vai trò `ADMIN` và `CUSTOMER`; bảng Redis tự làm mới mỗi 3s; đồ thị `vis-network` tô ĐỎ các node/cạnh gian lận kèm banner cảnh báo đỏ. | **PASS** |

