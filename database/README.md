# HƯỚNG DẪN CƠ SỞ DỮ LIỆU (DATABASE DOCUMENTATION & IMPORT)
## Đề tài 16: FinGuard Pro - Polyglot NoSQL (Neo4j + Redis)

Thư mục này chứa toàn bộ cấu trúc và dữ liệu mẫu của Cơ sở dữ liệu phục vụ nghiệm thu, kiểm thử và nộp đồ án.

---

### 1. Cấu trúc các tệp tin trong thư mục `database/`
* **`neo4j_dump.cypher`**: File xuất dữ liệu chuẩn (Cypher script dump) chứa toàn bộ:
  * Khởi tạo ràng buộc duy nhất (`CONSTRAINT`) trên `Account.accountId` và `Staff.staffId`.
  * Khởi tạo chỉ mục (`INDEX`) trên `txId` và `timestamp`.
  * 3 tài khoản Nhân viên (`:Staff`): `STAFF001` (ADMIN), `STAFF002` (ANALYST), `STAFF003` (ANALYST).
  * 50 tài khoản Khách hàng (`:Account`): `ACC001` đến `ACC050` với đầy đủ số dư và mật khẩu băm `bcrypt`.
  * 140 giao dịch chuyển tiền (`[:TRANSFERRED]`): gồm 3 chu trình rửa tiền khép kín 3 đỉnh, 15 giao dịch cho 3 pattern chuyên sâu (Structuring, Passthrough, Fanout), và 105 giao dịch nền DAG.

---

### 2. Các cách khởi tạo và nạp Cơ sở dữ liệu

#### 🔹 Cách 1: Nạp tự động 1 lệnh bằng Node.js (Khuyến nghị)
Hệ thống đã tích hợp sẵn script nạp toàn diện cả Neo4j và Redis:
```bash
# Cài đặt thư viện nếu chưa có
npm install

# Nạp toàn bộ dữ liệu mẫu vào cả Neo4j và Redis
npm run seed
```
> Khi khởi động server bằng `npm start`, nếu CSDL đang trống, hệ thống cũng sẽ **tự động nạp dữ liệu (Auto-Seed)** mà không cần thao tác thủ công.

---

#### 🔹 Cách 2: Nạp trực tiếp vào Neo4j Browser qua file `neo4j_dump.cypher`
1. Mở giao diện **Neo4j Browser** (hoặc Neo4j Desktop / Neo4j Aura Console).
2. Mở file `database/neo4j_dump.cypher`.
3. Sao chép toàn bộ nội dung và dán vào thanh lệnh Cypher của Neo4j Browser rồi nhấn **Run (Ctrl + Enter)**.
4. Kiểm tra lại kết quả:
   ```cypher
   MATCH (n) RETURN count(n); // Trả về 53 nodes (50 Account + 3 Staff)
   MATCH ()-[r:TRANSFERRED]->() RETURN count(r); // Trả về các giao dịch chuyển tiền
   ```

---

#### 🔹 Cách 3: Chạy CSDL cục bộ bằng Docker Compose
Nếu không sử dụng Cloud (Neo4j Aura & Upstash), bạn có thể chạy cụm CSDL local chỉ với 1 câu lệnh:
```bash
docker-compose up -d
npm run seed
```
* **Neo4j Browser**: `http://localhost:7474` (Tài khoản: `neo4j` / Mật khẩu: `password123`)
* **Redis**: `localhost:6379`

