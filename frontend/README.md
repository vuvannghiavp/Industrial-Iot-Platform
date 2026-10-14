# Nocturne · Smart Home Telemetry & Control Dashboard (TypeScript Frontend)

Giao diện điều khiển và giám sát Smart Home được thiết kế theo phong cách **Nocturne ("Night shift" Dark Glassmorphism)**, giao tiếp trực tiếp với backend **FastAPI** hiện có tại `http://localhost:8000` qua các endpoint thật; backend cho phép CORS từ frontend dev server.

## 1. Kiến trúc & Stack công nghệ

- **Ngôn ngữ**: TypeScript (`strict: true`)
- **Build & Dev Server**: Vite (`vite.config.ts`)
- **Kiến trúc phân tầng**:
  - `src/types/api.ts`: Định nghĩa hợp đồng dữ liệu chuẩn xác cho các REST API và sự kiện WebSocket.
  - `src/config/env.ts`: Quản lý biến môi trường (`VITE_API_BASE_URL`, `VITE_WS_BASE_URL`, `VITE_WS_PING_INTERVAL_MS`).
  - `src/services/tokenStore.ts`: Lưu trữ `access_token` và `refresh_token` an toàn trong RAM kết hợp `sessionStorage`, tuyệt đối không ghi log hay hiển thị token/mật khẩu ra console hoặc UI.
  - `src/services/apiClient.ts`: Shared HTTP Client dùng chung (`SmartHomeApiClient`), tự động đính kèm `Authorization: Bearer <access_token>`, xử lý `401 Unauthorized` bằng cơ chế gọi `POST /api/v1/auth/refresh` **tối đa một lần (single-flight)** rồi tự động yêu cầu đăng nhập lại nếu refresh thất bại.
  - `src/services/wsClient.ts`: Quản lý WebSocket (`ws://localhost:8000/ws/telemetry`), gửi access token qua `bearer` subprotocol thay vì query string để tránh lộ token trong access logs, gửi chuỗi `"ping"` định kỳ để duy trì `receive_text()` loop phía backend, và tự động kết nối lại theo **exponential backoff** (`1s -> 2s -> 4s -> ... -> 30s`) khi mất kết nối.
  - `src/state/dashboardStore.ts`: Quản lý trạng thái toàn cục, giữ giá trị cảm biến mới nhất theo `device_id` + `sensor_type`, và tách biệt hoàn toàn giữa chế độ **API Thật (`live`)** và chế độ **Dữ liệu mô phỏng (`simulation`)**.
  - `src/ui/app.ts` & `src/styles/nocturne.css`: Giao diện responsive cho Desktop, Tablet, Mobile theo thiết kế Nocturne.

## 2. Cấu hình Biến môi trường

Tạo file `.env` tại thư mục `frontend/` (hoặc sao chép từ `.env.example`):

```bash
cp .env.example .env
```

Các biến môi trường hỗ trợ:

| Biến môi trường | Mặc định | Mô tả |
| :--- | :--- | :--- |
| `VITE_API_BASE_URL` | `http://localhost:8000` | Base URL của FastAPI Backend |
| `VITE_WS_BASE_URL` | Tự suy ra từ `VITE_API_BASE_URL` (`ws://localhost:8000`) | Base URL cho kết nối WebSocket `/ws/telemetry` |
| `VITE_WS_PING_INTERVAL_MS` | `25000` | Chu kỳ gửi chuỗi `"ping"` duy trì kết nối WebSocket (ms) |

## 3. Các lệnh chạy dự án

```bash
# Di chuyển vào thư mục frontend
cd frontend

# Cài dependencies một lần
npm install

# Chạy frontend dev server
npm run dev
```

Mở `http://localhost:5173`. FastAPI phải chạy ở `http://localhost:8000`.
Backend cho phép CORS từ Vite dev server (`localhost`/`127.0.0.1:5173`) và
Vite đọc `VITE_API_BASE_URL`/`VITE_WS_BASE_URL` từ `.env` trong thư mục này.
Để đổi URL, sao chép `.env.example` thành `.env` rồi chỉnh giá trị phù hợp.
Không đặt token hoặc mật khẩu trong biến Vite; các biến `VITE_*` được đưa vào
bundle trình duyệt.

Các lệnh kiểm thử/build:

```bash
npm test
npm run build
```

Build tạo nội dung trong `dist/`. Để chạy bản build cục bộ, dùng `npm run preview`.
Không mở `dist/index.html` trực tiếp bằng `file://`; frontend cần HTTP để hoạt
động đúng với API và WebSocket.

## 4. Ghi chú về Giới hạn hiện tại của Backend (Known Limitations)

1. **Lệnh điều khiển chờ xác nhận trạng thái Modbus**:
   - Khi gọi `POST /api/v1/devices/{device_id}/control` với `{ "action": "turn_on" | "turn_off", "target": "fan" | "light" }`, mã phản hồi `HTTP 202 Accepted` chỉ xác nhận **backend đã nhận lệnh để publish lên MQTT**, không có nghĩa thiết bị vật lý đã thực thi thành công.
   - Giao diện tách biệt rõ 2 trường trên từng bộ điều khiển:
     - **Trạng thái lệnh mong muốn (Từ UI)**: Hiển thị `Đã gửi lệnh BẬT/TẮT / Đang chờ xác nhận (HTTP 202)`.
     - **Trạng thái thiết bị (Phần cứng)**: Cập nhật ON/OFF từ `actuators` trong telemetry, do gateway đọc trực tiếp từ các cuộn Modbus của quạt và đèn. Cùng luồng này cập nhật dashboard khi Node-RED bật/tắt tự động.
   - Khi chưa có telemetry trạng thái từ gateway, UI hiển thị `Chưa rõ`; sau khi gateway chạy và đọc được coil, `devices.fan_state`/`devices.light_state` giữ trạng thái cuối trong database.
   - Nếu Modbus coil của phần cứng không phản ánh trạng thái thiết bị vật lý (ví dụ relay hỏng hoặc actuator không có phản hồi), trạng thái hiển thị là trạng thái coil mà gateway đọc, không phải kiểm định điện áp/cơ khí độc lập.
2. **Trạng thái Online/Offline độc lập với trạng thái công tắc**:
   - Chỉ hiển thị `Online`/`Offline` dựa trên `is_online` và `last_seen_at` từ `GET /api/v1/devices` và gói tin WebSocket telemetry; không suy diễn trạng thái quạt/đèn từ trạng thái kết nối.
3. **Danh sách thiết bị phụ thuộc vào gói Telemetry đầu tiên**:
   - Nếu `GET /api/v1/devices` trả về mảng rỗng `[]`, giao diện hiển thị hướng dẫn rõ ràng rằng backend chỉ tự động khởi tạo thiết bị sau khi nhận gói telemetry đầu tiên và tuyệt đối không tự tạo thiết bị giả ở chế độ API thật.
4. **Lịch sử cảm biến (`GET /api/v1/sensors/history`)**:
   - Dù truyền tham số `interval` (`raw`, `1m`, `5m`, `1h`, `1d`), backend hiện trả về các điểm dữ liệu nguyên bản (`raw points`) chưa qua gom nhóm phía server.
