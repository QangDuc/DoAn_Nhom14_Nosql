# FinGuard Pro - Hệ Thống Phát Hiện Rửa Tiền & Chống Tấn Công Brute-Force
### Đồ án Đề tài 16: Ứng dụng Cơ sở dữ liệu NoSQL (Neo4j & Redis)

---

## 📌 1. GIỚI THIỆU DỰ ÁN
**FinGuard Pro** là hệ thống bảo mật và phân tích giao dịch ngân hàng theo mô hình **Polyglot Persistence**, kết hợp sức mạnh chuyên biệt của hai hệ quản trị CSDL NoSQL hàng đầu:
- **Neo4j (Graph Database):** Lưu trữ mạng lưới tài khoản và các luồng giao dịch tài chính dưới dạng đồ thị directed property graph `(:Account)-[:TRANSFERRED]->(:Account)`. Chuyên biệt cho bài toán phát hiện chu trình rửa tiền khép kín (A → B → C → A), đường đi đa chặng (3 - 5 đỉnh), và các mẫu hành vi bất thường (Structuring, Passthrough, Fanout).
- **Redis (In-Memory Key-Value & Data Structures):** Kiểm soát bảo mật tốc độ cao ở thời gian thực (< 5ms): bộ đếm giới hạn tần suất đăng nhập sai (INCR/EXPIRE), khóa tạm thời tài khoản và địa chỉ IP (TTL), quản lý phiên đăng nhập (Sessions), đóng băng tài khoản (Account Freezing), cấu hình chế độ bảo mật động (ALERT/BLOCK), và ghi vết kiểm toán thời gian thực qua Redis Stream (`security:events`).

Hệ thống tích hợp **In-Memory Fallback Engine** tự động: cho phép chạy toàn bộ kịch bản demo và phân tích đồ thị/bảo mật ngay cả khi môi trường chưa khởi chạy Docker.

---

## 🏗️ 2. KIẾN TRÚC POLYGLOT PERSISTENCE (NEO4J + REDIS)

```
                            [ Web Client / Admin Dashboard ]
                                          │
                                 REST API & SSE Stream
                                          ▼
                             [ Express.js Core Backend ]
                                    │           │
                 ┌──────────────────┘           └──────────────────┐
                 ▼                                                 ▼
        [ Redis In-Memory ]                                 [ Neo4j Graph DB ]
   (Tốc độ cực cao, TTL tức thời)                      (Mối quan hệ & Phân tích chu trình)
 ──────────────────────────────────                  ─────────────────────────────────────
 • login:fail:{accountId} (INCR/EXPIRE)              • (:Account {accountId, ownerName,
 • login:lock:{accountId} (SET EX 300)                  balance, status, createdAt})
 • login:ip:{ip} / login:ipblock:{ip}                • [:TRANSFERRED {txId, amount,
 • session:{token} (JSON Meta, TTL 3600)                timestamp, note}]
 • account:frozen:{accountId} (CYCLE / BRUTE_FORCE)  • Cypher: Quét chu trình 3 đỉnh & 4-5 đỉnh
 • config:fraud_mode (ALERT | BLOCK)                 • Cypher: Structuring, Passthrough, Fanout
 • security:events (Redis Stream XADD)               • executeWrite: ACID Atomic Transaction
```

### 2.1. Bản chất & Cơ chế cốt lõi: Atomic Transaction & Dictionary Attack
- **Atomic Transaction (Neo4j ACID):**
  - Thực thi theo nguyên lý **"All-or-Nothing"** qua `session.executeWrite()`.
  - Áp dụng **Pessimistic Write Lock** (`SET from._txLock = $timestamp`) ngay đầu transaction trước khi kiểm tra số dư nhằm ngăn chặn triệt để nguy cơ **Double-Spending** và **Race Condition** khi nhiều giao dịch diễn ra đồng thời.
  - Tự động **Rollback** toàn bộ nếu xảy ra bất kỳ lỗi nào (tài khoản đích bị đóng, thiếu số dư, hoặc bị BLOCK mode chặn do khép kín chu trình rửa tiền).
- **Dictionary Attack & Password Spraying (Phòng thủ đa tầng trên Redis):**
  - *Targeted Brute-Force:* Khóa tài khoản 300s khi nhập sai 5 lần (`login:fail` $\rightarrow$ `login:lock`), đồng thời tự động thu hồi mọi phiên đăng nhập cũ (**Session Revocation**).
  - *Password Spraying (Thử rải rác mật khẩu Dictionary Attack qua nhiều tài khoản):* Cấu trúc Redis Set `login:ip:{ip}:accounts` phát hiện 1 IP thử sai trên $\ge 5$ tài khoản khác nhau sẽ kích hoạt **IP Block** trong 600s (`login:ipblock`), từ chối ngay từ tầng middleware.
  - *Anti-Account Enumeration:* Trả về cùng mã `401 Unauthorized` và vẫn tăng bộ đếm phạt khi tài khoản không tồn tại, ngăn chặn dò quét danh sách khách hàng.

---

## 📝 3. NHẬT KÝ CÁC THAY ĐỔI & TỐI ƯU HÓA HOÀN TẤT HÔM NAY (24/10/2026)

Hôm nay hệ thống đã trải qua đợt nâng cấp toàn diện từ giao diện, backend, xử lý CSDL phân tán đến tự động hóa kiểm thử:

### 3.1. Tối ưu Giao diện Dashboard Admin "FinGuard Pro" (Chuẩn màn hình chiếu 1920x1080)
- **Bảng giám sát Redis:**
  - Badge trạng thái `ĐÃ KHÓA 429` hiển thị gọn trên 1 dòng duy nhất.
  - Cột header không ngắt dòng, nút "Mở khóa" thiết kế chuẩn 1 dòng.
  - Thanh tiến trình TTL hiển thị rõ nét với hiệu ứng chuyển màu theo thời gian đếm ngược thực.
  - Mở rộng viewport bảng Redis hiển thị tối thiểu 6 dòng không bị thanh cuộn cắt cụt.
- **Đồ thị quan hệ trực quan (vis-network):**
  - Cân đối trọng tâm đồ thị, tăng kích thước node và luôn hiển thị nhãn ID tài khoản.
  - Các chu trình gian lận được tô đỏ rực rỡ (`#ef4444`) với mũi tên động, tách biệt khỏi các cụm giao dịch bình thường.
  - Tối ưu thanh công cụ góc ("Căn khung", "Chỉ hiện chu trình", "Zoom chu trình").
- **Phân cấp màu sắc nghiêm ngặt:**
  - Màu **Đỏ** chỉ dùng duy nhất cho: Chu trình rửa tiền, Trạng thái Khóa/Đóng băng, và Hành động xóa vĩnh viễn.
  - Nút hành động chính ("Quét Gian Lận", "Đăng Nhập", "Chuyển tiền") chuyển sang sắc **Xanh thương hiệu** chuẩn ngân hàng.
- **Chuẩn hóa form giao dịch:**
  - Áp dụng cấu trúc Form toàn cục: nhãn nằm trên ô nhập, padding 12px, bo góc 8px, loại bỏ hàng KPI dư thừa.

### 3.2. Nâng cấp Backend & Truy vấn Đồ thị Neo4j
- **Khắc phục lỗi nhân bản chu trình:** Sửa câu truy vấn Cypher và tầng gom dữ liệu theo bộ ba `(a, b, c)`. Khi có nhiều giao dịch song song giữa cùng các cặp tài khoản, hệ thống gom toàn bộ cạnh vào mảng `txIds`, giữ KPI chu trình chính xác tuyệt đối (3 chu trình gốc, không bị tăng ảo thành 9).
- **Phát hiện chu trình độ dài lớn (3 - 5 đỉnh):** Bổ sung endpoint `GET /api/fraud/cycles/long?minLen=3&maxLen=5` với thuật toán duyệt đường đi không trùng lặp node trung gian, chuẩn hóa theo đỉnh nhỏ nhất và hỗ trợ kiểm tra thứ tự thời gian (`ordered=true`).
- **Phát hiện 3 mẫu gian lận rửa tiền nâng cao:**
  - *Structuring:* Chia nhỏ dòng tiền dưới ngưỡng 10 triệu trong 24h.
  - *Passthrough:* Dòng tiền quá cảnh, nhận từ nhiều nguồn rồi chuyển tiếp >= 90% trong cửa sổ thời gian trượt 30 phút.
  - *Fanout:* Phân tán dòng tiền từ 1 nguồn ra >= 8 tài khoản khác nhau trong 1 giờ.
- **Chế độ Chặn giao dịch (BLOCK mode):** Kiểm tra chu trình tức thời bằng `preCheck` trong `POST /api/transactions`. Nếu phát hiện giao dịch khép vòng gian lận ở chế độ BLOCK, hệ thống hủy giao dịch ngay lập tức (HTTP 409 Conflict), rollback toàn bộ số dư và ghi nhận cảnh báo.

### 3.3. Tăng cường Bảo mật Tốc độ cao với Redis
- **Chống Brute-force đa tầng (Account + IP):**
  - Giới hạn 5 lần sai theo tài khoản: khóa 300s, tự động xóa bộ đếm fail khi khóa.
  - Phòng thủ theo địa chỉ IP: theo dõi số lần sai (`login:ip:{ip}`) và số tài khoản khác nhau bị thử (`login:ip:{ip}:accounts`). Chặn IP (HTTP 429) khi sai >= 20 lần hoặc thử >= 5 tài khoản.
  - Chống Account Enumeration: Tài khoản không tồn tại vẫn trả cùng mã 401 và vẫn bị đếm thất bại.
- **Đóng băng tài khoản liên kết (Account Freezing):** Tự động đặt khóa `account:frozen:{id}` khi bị khóa Brute-force hoặc khi tham gia chu trình gian lận; chặn toàn bộ giao dịch đi và đến tài khoản bị đóng băng (HTTP 423).
- **Quản lý phiên & Thu hồi tức thì:** Lưu phiên dạng JSON metadata trong `session:{token}`. Hỗ trợ Admin thu hồi theo `sessionId` hoặc theo `accountId`. Tự động thu hồi phiên khi tài khoản bị khóa.
- **Đánh giá điểm rủi ro Polyglot Matrix (`/api/risk/scores`):** Kết hợp phân tích đồ thị Neo4j (chu trình +40đ, số đối tác +20đ) và khóa Redis (số lần sai +25đ, trạng thái khóa +15đ) sử dụng Redis Pipeline để đạt hiệu năng tối đa.
- **Kiểm toán thời gian thực với Redis Stream:** Ghi nhận 8 loại sự kiện bảo mật vào luồng `security:events` qua `XADD MAXLEN ~ 1000` và phát trực tiếp cho Dashboard qua Server-Sent Events (SSE).

### 3.4. Xây dựng Môi trường & Bộ Kiểm thử Tự động Toàn diện (Jest + Supertest)
- **Môi trường Test cô lập 100%:**
  - Tạo [docker-compose.test.yml](docker-compose.test.yml) với cổng riêng 7688 (Neo4j) và 6380 (Redis).
  - Tạo [.env.test](.env.test) với TTL ngắn phục vụ kiểm thử nhanh (khóa 2s, fail window 10s), key admin thử nghiệm.
  - Tách Express App trong [src/server.js](src/server.js) để phục vụ test mà không phụ thuộc vào `listen`.
- **7 File Test chuyên biệt (`tests/`):**
  - `auth.test.js` (5 tests): Brute-force, mở khóa sau TTL, chống dò tài khoản, token, admin key.
  - `ip.test.js` (2 tests): Chặn IP tấn công Dictionary Attack (Password Spraying) trên 5 tài khoản, bảo vệ IP sạch.
  - `sessions.test.js` (3 tests): Khởi tạo phiên, admin thu hồi phiên, tự động hủy phiên khi khóa.
  - `transactions.test.js` (5 tests): Tự chuyển tiền, thiếu số dư, tài khoản đóng, tài khoản đóng băng, và Race condition 5 luồng song song chống double-spend.
  - `fraud.test.js` (6 tests): Quét 3 chu trình gốc, gom nhóm cạnh song song, BLOCK mode chặn khép vòng (409), chu trình 4 đỉnh, và 3 pattern gian lận.
  - `risk.test.js` (1 test): Tính điểm rủi ro cho 50 tài khoản, kiểm tra phân cấp rủi ro.
  - `events.test.js` (1 test): Kiểm tra ghi nhận sự kiện `LOGIN_FAIL` và `ACCOUNT_LOCKED` lên Redis Stream.
- **Kết quả Kiểm thử:** Đạt **100% PASS** (7/7 Suites, 23/23 Tests), độ bao phủ mã nguồn đạt **63.30%** (Middleware 81.56%, Risk 93.18%, Neo4j 79.58%, Seed 90.81%).
- **Báo cáo chuẩn khoa học:** Khởi tạo [docs/TEST_REPORT.md](docs/TEST_REPORT.md) ghi nhận đầy đủ số liệu thực tế và bảng ánh xạ 14 yêu cầu đề tài.

---

## 📊 4. KẾT QUẢ KIỂM THỬ TỰ ĐỘNG (SUMMARY TEST REPORT)

```
Test Suites: 7 passed, 7 total
Tests:       23 passed, 23 total
Snapshots:   0 total
Time:        10.042 s
Ran all test suites.
Coverage:    63.30% Lines toàn hệ thống
Dữ liệu Demo cổng 3000: Giữ nguyên vẹn 50 nodes, 114 edges, 3 cycles
```

---

## 🚀 5. HƯỚNG DẪN KHỞI CHẠY HỆ THỐNG & TRÌNH CHIẾU DEMO

### 5.1. Khởi chạy Server
```bash
# Cài đặt thư viện (nếu cài mới)
npm install

# Khởi động ứng dụng
npm start
```
Server sẽ chạy tại: **http://localhost:3000**  
Mở trình duyệt truy cập Web Dashboard: **http://localhost:3000/index.html**

### 5.2. Chạy thử Kịch bản Demo tự động từ Terminal
```bash
# Chạy toàn bộ kịch bản mẫu tổng hợp (Brute-force, Chuyển tiền khép vòng, Quét đồ thị)
node scripts/run-demo.js

# Kiểm chuẩn các truy vấn chu trình độ dài lớn & 3 pattern gian lận
node scripts/verify-patterns.js

# Kiểm thử tính năng Polyglot tương tác Neo4j & Redis
node scripts/verify-polyglot.js
```

### 5.3. Chạy Bộ Kiểm thử Tự động (Unit/Integration Tests)
```bash
# Chạy toàn bộ 23 bài test tự động
npm test

# Chạy test kèm thống kê chi tiết độ bao phủ mã nguồn (Coverage)
npm run test:coverage
```

### 5.4. Tài khoản Demo có sẵn
- **Mật khẩu chung:** `MatKhau@123`
- **Khóa quản trị Admin (x-admin-key):** `admin_secret_key_123`
- **Danh sách chu trình gài sẵn:**
  1. `ACC001` → `ACC002` → `ACC003` → `ACC001` (148.500.000 đ)
  2. `ACC004` → `ACC005` → `ACC006` → `ACC004` (237.500.000 đ)
  3. `ACC007` → `ACC008` → `ACC009` → `ACC007` (355.500.000 đ)
- **Tài khoản dùng cho kịch bản tạo chu trình mới #4:** `ACC030`, `ACC031`, `ACC032`

---

## 📁 6. CẤU TRÚC THƯ MỤC DỰ ÁN

```
DoAn16_Nosql/
├── public/                 # Giao diện Web Dashboard Admin (FinGuard Pro)
│   ├── index.html          # Trang điều khiển chính 1920x1080
│   ├── css/app.css         # Hệ thống định kiểu phân cấp màu chuẩn
│   └── js/app.js           # Xử lý tương tác, biểu đồ vis-network & SSE
├── src/                    # Mã nguồn Backend Express.js
│   ├── server.js           # Cấu hình server Express, export app
│   ├── seed.js             # Hàm khởi tạo 50 Account + 114 giao dịch + 3 chu trình
│   ├── config/             # Kết nối Neo4j (kèm Cypher Fallback) & Redis (kèm Mock Fallback)
│   ├── middleware/         # Bảo mật bruteForce.js & authMiddleware.js
│   ├── routes/             # REST APIs (auth, accounts, transactions, fraud, risk, events...)
│   └── services/           # cypherQueries.js & Redis Stream events.js
├── tests/                  # Bộ kiểm thử tự động (Jest & Supertest)
│   ├── setup.js            # Nạp cấu hình .env.test
│   ├── testHelper.js       # Hàm tiện ích reset/clean CSDL test
│   ├── auth.test.js        # Kiểm thử xác thực & chống brute-force
│   ├── ip.test.js          # Kiểm thử phòng thủ IP
│   ├── sessions.test.js    # Kiểm thử quản lý phiên đăng nhập
│   ├── transactions.test.js# Kiểm thử giao dịch ACID & concurrency
│   ├── fraud.test.js       # Kiểm thử chu trình đồ thị & patterns
│   ├── risk.test.js        # Kiểm thử ma trận điểm rủi ro
│   └── events.test.js      # Kiểm thử Redis Stream audit log
├── scripts/                # Kịch bản demo và kiểm chuẩn tự động
│   ├── run-demo.js         # Kịch bản demo toàn diện cho hội đồng
│   ├── verify-patterns.js  # Kiểm chuẩn Cypher phân tích sâu
│   └── verify-polyglot.js  # Kiểm chuẩn tương tác hai CSDL
├── docs/                   # Tài liệu báo cáo
│   └── TEST_REPORT.md      # Báo cáo kết quả kiểm thử tự động chi tiết
├── docker-compose.yml      # Cấu hình Docker Neo4j & Redis chính
├── docker-compose.test.yml # Cấu hình Docker Neo4j (7688) & Redis (6380) cho test
├── .env.example            # Cấu hình biến môi trường mẫu
├── .env.test               # Cấu hình biến môi trường kiểm thử
├── jest.config.js          # Cấu hình Jest runner
├── DEMO.md                 # Kịch bản thuyết trình demo chi tiết
└── README.md               # Tài liệu tổng quan dự án & nhật ký cập nhật
```

