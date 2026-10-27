# BÁO CÁO KIỂM THỬ TỰ ĐỘNG HỆ THỐNG (TEST REPORT)

**Dự án:** Đề tài 16 - Phát hiện Chu trình Gian lận Rửa tiền (Neo4j) & Chống Tấn công Brute-Force (Redis)  
**Ngày thực hiện:** 24/10/2026  
**Công cụ kiểm thử:** Jest v30.5.2, Supertest v7.3.1  
**Môi trường:** Isolated Test Environment (`.env.test`, Neo4j cổng 7688, Redis cổng 6380, Express App)

---

## 1. TỔNG QUAN KẾT QUẢ KIỂM THỬ

| Chỉ số | Giá trị thực tế | Ghi chú |
| :--- | :--- | :--- |
| **Tổng số Test Suites** | **7** | `auth`, `ip`, `sessions`, `transactions`, `fraud`, `risk`, `events` |
| **Test Suites PASSED** | **7 / 7** | **100%** |
| **Test Suites FAILED** | **0 / 7** | **0%** |
| **Tổng số Test Cases** | **23** | |
| **Test Cases PASSED** | **23 / 23** | **100%** |
| **Test Cases FAILED** | **0 / 23** | **0%** |
| **Thời gian thực thi** | **10.042 s** | Chạy đơn luồng tuần tự (`--runInBand`) |
| **Độ bao phủ dòng (Lines Coverage)** | **63.30% toàn bộ dự án** | Middleware: 81.56%, Risk: 93.18%, Events: 100%, Seed: 90.81%, Neo4j: 79.58% |

---

## 2. KẾT QUẢ CHI TIẾT THEO TỪNG NHÓM KIỂM THỬ

### 2.1. Nhóm Xác thực & Chống Brute-force (`tests/auth.test.js`) - PASS (5/5)
- [x] **5 wrong attempts trigger 429 lock with TTL <= 2s**: Nhập sai mật khẩu liên tiếp 5 lần; 4 lần đầu trả về `401`, lần thứ 5 trả về `429` với cờ `locked: true`, `remainingSeconds <= 2`. Khóa Redis `login:lock:{accountId}` có TTL thực tế `<= 2s`.
- [x] **After lock expiry, correct login succeeds and fail count resets to 0**: Đợi hết 2.2 giây TTL của khóa; đăng nhập lại với mật khẩu đúng `MatKhau@123` thành công (`200 OK`), cấp phát session token và bộ đếm sai `login:fail:{accountId}` tự động xóa về 0/null.
- [x] **Non-existent account returns 401 and increments fail counter in Redis**: Tài khoản không tồn tại trong hệ thống (`ACC999`) vẫn trả về cùng mã `401 Unauthorized` và tăng bộ đếm `login:fail:ACC999` lên 1 (chống kỹ thuật Account Enumeration).
- [x] **Missing Bearer token on POST /api/transactions returns 401**: Gửi yêu cầu chuyển tiền thiếu header `Authorization` trả về `401`.
- [x] **Missing or invalid x-admin-key on admin routes returns 403**: Truy cập các endpoint quản trị không có `x-admin-key` hoặc truyền sai key bị từ chối với mã `403 Forbidden`.

### 2.2. Nhóm Phòng thủ theo Địa chỉ IP (`tests/ip.test.js`) - PASS (2/2)
- [x] **5 wrong logins across 5 accounts from same x-demo-ip triggers IP block**: Kịch bản tấn công phân tán dò mật khẩu trên 5 tài khoản khác nhau từ cùng một IP (`192.168.88.99`). Tại lần thử thứ 5, hệ thống phát hiện đạt ngưỡng `IP_MAX_ACCOUNTS = 5` và lập tức chặn IP với mã `429`, `scope: 'ip'`, `blocked: true`. Mọi yêu cầu tiếp theo từ IP này đều bị từ chối ngay ở tầng middleware.
- [x] **A clean IP remains completely unaffected**: Một IP sạch khác gửi yêu cầu đăng nhập hợp lệ vẫn được xử lý bình thường (`200 OK`), không bị ảnh hưởng bởi IP đang bị chặn.

### 2.3. Nhóm Quản lý Phiên Đăng nhập (`tests/sessions.test.js`) - PASS (3/3)
- [x] **Login creates session and /api/auth/me returns user info**: Đăng nhập thành công tạo khóa `session:{token}` trong Redis, gọi `/api/auth/me` với Bearer token trả về đúng thông tin tài khoản.
- [x] **Admin revoking session invalidates token**: Quản trị viên thu hồi phiên qua API `POST /api/auth/admin/sessions/revoke` với `sessionId` (8 ký tự đầu token); sau khi thu hồi, client gọi lại `/api/auth/me` lập tức bị từ chối với mã `401`.
- [x] **Account lock automatically revokes all active sessions for that account**: Khi một tài khoản bị khóa do 5 lần nhập sai mật khẩu, hệ thống tự động xóa toàn bộ phiên đăng nhập đang hoạt động của tài khoản đó.

### 2.4. Nhóm Atomic Transaction & Chống Double-Spend (`tests/transactions.test.js`) - PASS (5/5)
- [x] **Self-transfer is rejected with 400**: Chuyển tiền cho chính mình bị từ chối với mã `400 Bad Request`.
- [x] **Insufficient balance is rejected with 400**: Số dư không đủ bị từ chối với mã `400`.
- [x] **Transfer involving a closed account is rejected with 400**: Giao dịch liên quan đến tài khoản có trạng thái `CLOSED` bị từ chối với mã `400`.
- [x] **5 parallel transactions of 60% balance: exactly 1 succeeds and balance >= 0**: Kiểm thử Concurrency / Race Condition bằng 5 request song song đồng thời trừ 60% số dư. Kết quả: duy nhất 1 request thành công (`201 Created`), 4 request còn lại bị từ chối (`400`), số dư cuối cùng trừ đúng 60% và không bị âm.
- [x] **Transfer involving frozen account returns 423**: Giao dịch gửi từ tài khoản đang bị đóng băng trong Redis (`account:frozen:{id}`) bị chặn ngay lập tức với mã `423 Locked`.

### 2.5. Nhóm Điểm số Rủi ro Polyglot (`tests/risk.test.js`) - PASS (1/1)
- [x] **GET /api/risk/scores returns 50 accounts with scores in [0, 100] and cycle accounts >= MEDIUM**: Trả về đủ 50 tài khoản; điểm rủi ro nằm trong khoảng [0, 100]; toàn bộ tài khoản nằm trong chu trình gian lận (`ACC001` - `ACC009`) đều có điểm >= 40 và mức độ rủi ro `>= MEDIUM`.

### 2.6. Nhóm Sự kiện Bảo mật Redis Stream (`tests/events.test.js`) - PASS (1/1)
- [x] **5 failed logins publish 5 LOGIN_FAIL events and 1 ACCOUNT_LOCKED event to Redis Stream**: 5 lần đăng nhập thất bại liên tiếp sinh ra đúng 5 sự kiện `LOGIN_FAIL` và 1 sự kiện `ACCOUNT_LOCKED` trên luồng Redis Stream `security:events`.

### 2.7. Nhóm Phát hiện Chu trình Gian lận & Pattern (`tests/fraud.test.js`) - PASS (6/6)
- [x] **Fresh seed returns exactly 3 cycles**: CSDL sau khi seed trả về chính xác 3 chu trình khép kín.
- [x] **Creating ACC030->ACC031->ACC032->ACC030 twice still yields 4 cycles (no duplicates)**: Tạo 2 tập cạnh song song cho cùng bộ ba tài khoản; kết quả chu trình chỉ tăng thêm 1 (từ 3 lên 4), các mã giao dịch được gom vào `txIds` mà không nhân bản dòng.
- [x] **BLOCK mode returns 409 and balances are unchanged when completing cycle**: Ở chế độ `BLOCK`, giao dịch cố gắng khép kín chu trình bị chặn với mã `409 Conflict`, tiền trên tài khoản không bị trừ.
- [x] **/cycles/long?minLen=3&maxLen=3 matches /cycles count**: Quét độ dài biến đổi [3..3] cho ra số lượng chu trình bằng truy vấn chuẩn 3 đỉnh.
- [x] **4-node cycle is detected by /cycles/long?minLen=4&maxLen=4**: Chu trình 4 đỉnh (`ACC045 -> ACC046 -> ACC047 -> ACC048 -> ACC045`) được phát hiện chính xác.
- [x] **3 patterns after seed-patterns each return >= 1 item**: Sau khi nạp giao dịch mẫu, 3 pattern rửa tiền nâng cao đều được phát hiện: Structuring (`ACC034 -> ACC035`), Passthrough (`ACC036..038 -> ACC039 -> ACC040`), và Fanout (`ACC041 -> ACC042..ACC049`).

---

## 3. BẢNG ĐỐI CHIẾU: YÊU CẦU ĐỀ TÀI → TEST CHỨNG MINH

| Yêu cầu nghiệp vụ đề tài | File test & Test Case chứng minh | Kết quả |
| :--- | :--- | :--- |
| **Phát hiện chu trình rửa tiền 3 đỉnh khép kín** | `tests/fraud.test.js` > *Fresh seed returns exactly 3 cycles* | **PASS** |
| **Gom nhóm chu trình theo bộ ba, không trùng lặp cạnh song song** | `tests/fraud.test.js` > *Creating ACC030->ACC031->ACC032->ACC030 twice still yields 4 cycles* | **PASS** |
| **Phát hiện chu trình độ dài lớn (4 đỉnh)** | `tests/fraud.test.js` > *4-node cycle is detected by /cycles/long?minLen=4&maxLen=4* | **PASS** |
| **Chế độ chặn giao dịch thời gian thực (BLOCK mode)** | `tests/fraud.test.js` > *BLOCK mode returns 409 and balances are unchanged* | **PASS** |
| **Chống brute-force: Khóa sau 5 lần sai (TTL)** | `tests/auth.test.js` > *5 wrong attempts trigger 429 lock with TTL <= 2s* | **PASS** |
| **Chống brute-force: Tự động phục hồi & reset sau khi hết TTL** | `tests/auth.test.js` > *After lock expiry, correct login succeeds and fail count resets to 0* | **PASS** |
| **Chống dò tài khoản (Account Enumeration)** | `tests/auth.test.js` > *Non-existent account returns 401 and increments fail counter* | **PASS** |
| **Chống brute-force phân tán theo IP** | `tests/ip.test.js` > *5 wrong logins across 5 accounts from same x-demo-ip triggers IP block* | **PASS** |
| **Bảo vệ xác thực & phân quyền Admin** | `tests/auth.test.js` > *Missing or invalid x-admin-key on admin routes returns 403* | **PASS** |
| **Quản lý phiên & thu hồi phiên đăng nhập tức thì** | `tests/sessions.test.js` > *Admin revoking session invalidates token* | **PASS** |
| **Atomic Transaction, chống gian lận số dư (Race condition)** | `tests/transactions.test.js` > *5 parallel transactions of 60% balance: exactly 1 succeeds* | **PASS** |
| **Đóng băng tài khoản khi phát hiện dấu hiệu bất thường** | `tests/transactions.test.js` > *Transfer involving frozen account returns 423* | **PASS** |
| **Điểm số rủi ro Polyglot (kết hợp đồ thị Neo4j & khóa Redis)** | `tests/risk.test.js` > *GET /api/risk/scores returns 50 accounts with scores in [0, 100]* | **PASS** |
| **Ghi nhận sự kiện kiểm toán thời gian thực qua Redis Stream** | `tests/events.test.js` > *5 failed logins publish 5 LOGIN_FAIL events and 1 ACCOUNT_LOCKED* | **PASS** |

---

## 4. BẢNG ĐỘ BAO PHỦ MÃ NGUỒN (CODE COVERAGE)

*Trích xuất từ kết quả thực tế lệnh `npm run test:coverage`:*

```
--------------------|---------|----------|---------|---------|-------------------
File                | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s 
--------------------|---------|----------|---------|---------|-------------------
All files           |   62.31 |    47.55 |   58.42 |    63.3 |                   
 src                |    77.4 |       30 |    37.5 |   76.74 |                   
  seed.js           |   91.26 |     62.5 |      50 |   90.81 | 115,209-219       
  server.js         |    58.1 |     8.33 |      25 |    58.1 | 28-30,48-56,121.. 
 src/config         |   70.33 |    57.72 |   68.93 |   72.74 |                   
  neo4j.js          |   77.11 |    63.03 |   79.66 |   79.58 | 34-35,41-42,237.. 
  redis.js          |   58.95 |    48.06 |   54.54 |   61.76 | 88-95,119-121,136.
 src/middleware     |   79.89 |     61.4 |     100 |   81.56 |                   
  authMiddleware.js |   89.33 |    77.77 |     100 |   92.95 | 19,47-48,78,110   
  bruteForce.js     |   73.39 |    53.84 |     100 |   74.07 | 22-23,59,68-106.. 
 src/routes         |   47.57 |    34.14 |    38.8 |   48.44 |                   
  accounts.js       |   12.12 |        0 |       0 |   12.24 | 13-37,46-70...    
  auth.js           |   46.29 |    35.86 |   47.05 |   47.11 | 39,59,67,87...    
  demo.js           |   12.72 |        0 |       0 |   13.46 | 30-60,71-129      
  events.js         |   24.59 |    12.19 |      25 |   25.86 | 21,36-37,49-123   
  fraud.js          |   67.31 |    41.89 |   71.42 |   68.15 | 57,78-86,186...   
  risk.js           |   93.33 |    83.33 |     100 |   93.18 | 77,98-99          
  security.js       |   33.33 |    21.42 |      20 |   34.09 | 12-17,29,40-41... 
  transactions.js   |      64 |    52.94 |      50 |    65.3 | 21,28,59-65,94... 
 src/services       |   77.14 |    46.66 |      75 |   78.78 |                   
  cypherQueries.js  |   46.15 |        0 |      50 |   46.15 | 173-224           
  events.js         |   95.45 |    63.63 |     100 |     100 | 20-24,47-58,63-64 
--------------------|---------|----------|---------|---------|-------------------
```

---

## 5. BẰNG CHỨNG DỮ LIỆU DEMO KHÔNG BỊ ẢNH HƯỞNG

Để đảm bảo tuân thủ nghiêm ngặt nguyên tắc **"Tests KHÔNG được chạm dữ liệu demo"**:
- Quá trình test sử dụng cổng cấu hình riêng (`PORT=3001`, `NEO4J_URI=bolt://localhost:7688`, `REDIS_PORT=6380`) trong `.env.test`.
- Kiểm tra trạng thái CSDL trên cổng Demo (3000) ngay sau khi toàn bộ suite test kết thúc:
  - `totalNodes`: **50** (Nguyên vẹn từ ACC001 đến ACC050)
  - `totalEdges`: **114** (Đúng 9 giao dịch chu trình + 105 giao dịch DAG ban đầu)
  - `cycleCount`: **3** (Chỉ gồm 3 chu trình gốc đã gài sẵn)
- Dữ liệu demo hoàn toàn không bị thay đổi, xóa bỏ hay ghi đè.

---

## 6. LỖI PHÁT HIỆN & ĐÃ XỬ LÝ (ĐÃ ĐƯỢC NGƯỜI DÙNG PHÊ DUYỆT)

### 6.1. Vấn đề ban đầu
- **Tên test:** `tests/fraud.test.js` > `3 patterns after seed-patterns each return >= 1 item`.
- **Vị trí:** `src/services/cypherQueries.js` dòng 108 & `src/config/neo4j.js` dòng 628.
- **Nguyên nhân:** Truy vấn Cypher `CYPHER_PASSTHROUGH` thu thập toàn bộ giao dịch vào `midAccount` mà không giới hạn mốc cửa sổ thời gian trượt (`$inWindowMs`), dẫn đến việc tài khoản trung gian đã có giao dịch DAG từ dữ liệu seed ban đầu bị kéo dài khoảng cách `(latestInTime - earliestInTime)` vượt quá 30 phút. Đồng thời trong file test, bước kiểm thử BLOCK mode trước đó sử dụng các tài khoản trùng với tài khoản kịch bản Passthrough.

### 6.2. Giải pháp đã thực hiện (với sự đồng ý của người dùng)
1. **Cập nhật `CYPHER_PASSTHROUGH`:** Sử dụng kỹ thuật mốc bắt đầu cửa sổ (`rInBase` tương tự `CYPHER_FANOUT`) với điều kiện `rIn.timestamp >= rInBase.timestamp AND rIn.timestamp <= rInBase.timestamp + $inWindowMs` để chỉ tính các giao dịch vào nằm trọn vẹn trong khung thời gian trượt.
2. **Cập nhật In-memory Fallback:** Áp dụng cùng logic duyệt cửa sổ thời gian trượt theo danh sách giao dịch đã sắp xếp thời gian.
3. **Cô lập tài khoản kiểm thử BLOCK mode:** Chuyển sang sử dụng `ACC027`, `ACC028`, `ACC029` độc lập để không ảnh hưởng đến các tài khoản mẫu `ACC036..ACC040`.

**Kết quả sau xử lý:** Toàn bộ 7 Test Suites và 23 Test Cases đạt **100% PASS**.
