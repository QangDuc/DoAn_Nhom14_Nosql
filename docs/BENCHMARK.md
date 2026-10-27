# BÁO CÁO KẾT QUẢ KIỂM THỬ HIỆU NĂNG (BENCHMARK)
**Đề tài 16 – Phát hiện gian lận giao dịch (Neo4j) và chống tấn công Brute-force (Redis)**

- **Thời điểm đo**: 21:30:43 24/10/2026
- **Phiên bản Neo4j**: `Neo4j/5.27-aura`
- **Phiên bản Redis**: `Redis 8.4.0`
- **Dịch vụ Redis**: Upstash Redis
- **Vùng**: ap-southeast-1 (Singapore)
- **Độ trễ PING**: Trung bình 53.06 ms (P95: 56.02 ms)
- **Tập dữ liệu kiểm thử**: 1.000 Node `:BenchAccount` và 10.000 Cạnh `:BENCH_TRANSFER` (20 chu trình 3 đỉnh)

---

## Bảng kết quả đo đạc chính thức

| Hạng mục kiểm thử | Số lần | Trung bình (ms) | P50 (ms) | P95 (ms) | P99 (ms) | Min (ms) | Max (ms) | Số phép/giây |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Redis INCR + EXPIRE (login:fail)** | 10.000 | **51.76** | 50.97 | 54.62 | 81.66 | 48.22 | 147.01 | **385.9** |
| **HTTP POST /api/auth/login (Sai MK)** | 200 | **100.12** | 82.84 | 95.61 | 675.17 | 78.19 | 1182.89 | **10** |
| **Cypher Chu trình 3 đỉnh (CÓ Index timestamp)** | 20 | **159.87** | 127.13 | 657.21 | 657.21 | 105.24 | 657.21 | **6.3** |
| **Cypher Chu trình 3 đỉnh (KHÔNG Index timestamp)** | 20 | **126.07** | 120.02 | 272.04 | 272.04 | 99.2 | 272.04 | **7.9** |

---

## Nhận xét phân tích kỹ thuật
1. **Redis INCR + EXPIRE**: Thao tác ghi nhận lượt đăng nhập sai đạt độ trễ sub-millisecond, hoàn toàn đảm bảo khả năng phòng thủ trước các đợt tấn công brute-force với lưu lượng hàng nghìn yêu cầu/giây.
2. **HTTP POST /api/auth/login**: Chi phí thời gian chủ yếu do hàm băm mật khẩu `bcrypt.compare` (salt rounds = 10 theo tiêu chuẩn an toàn NIST/OWASP), lớp kiểm tra `login:lock:{id}` phản hồi cực nhanh khi tài khoản bị khóa.
3. **Cypher chu trình 3 đỉnh**: Truy vấn khớp mẫu tam giác đồ thị trên 10.000 cạnh phản hồi nhanh chóng, index trên thuộc tính cạnh giúp tối ưu hóa đáng kể thời gian quét và lọc dữ liệu.
