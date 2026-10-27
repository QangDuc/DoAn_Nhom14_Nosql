const path = require('path');
const dotenv = require('dotenv');

// Nạp file cấu hình môi trường test riêng biệt
dotenv.config({ path: path.resolve(__dirname, '../.env.test'), override: true });

// Tăng timeout mặc định cho các bài test có độ trễ/chờ TTL
jest.setTimeout(20000);

