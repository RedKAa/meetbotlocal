# Đề xuất cải tiến cho Meetbot

Dựa trên phân tích so sánh giữa cách lấy audio trong `meetbot.js` hiện tại và cách làm trong các file docs sử dụng RTC, dưới đây là các đề xuất cải tiến để nâng cấp meetbot có khả năng phân biệt người nói từ các luồng âm thanh.

## 1. Cải tiến chính cho meetbot.js

### 1.1. Chuyển từ DOM-based sang RTC-based audio capture
**Vấn đề hiện tại**: meetbot.js sử dụng DOM elements để lấy audio, dẫn đến việc chỉ thu được audio đã trộn.
**Giải pháp**:
- Sử dụng RTCPeerConnection interceptor như trong docs để capture trực tiếp các audio track từ WebRTC
- Hook vào `peerConnection.addEventListener('track', ...)` thay vì duyệt qua DOM elements

### 1.2. Sử dụng MediaStreamTrackProcessor cho từng audio track
**Vấn đề hiện tại**: meetbot.js trộn tất cả audio thành một stream duy nhất.
**Giải pháp**:
- Sử dụng MediaStreamTrackProcessor cho từng audio track riêng biệt
- Giữ nguyên cấu trúc xử lý audio nhưng áp dụng cho từng track riêng biệt

### 1.3. Tích hợp RTCRtpReceiver để xác định contributing sources
**Vấn đề hiện tại**: meetbot.js không có cơ chế xác định ai đang nói.
**Giải pháp**:
- Sử dụng RTCRtpReceiver interceptor để capture contributing sources
- Ánh xạ contributing sources với thông tin người dùng từ UserManager
- Xác định người đang nói dựa trên audioLevel từ contributing sources

### 1.4. Tạo cấu trúc dữ liệu để lưu trữ audio theo người dùng
**Vấn đề hiện tại**: meetbot.js chỉ có một luồng audio duy nhất.
**Giải pháp**:
- Tạo map để lưu trữ audio data theo participantId
- Lưu trữ separate audio streams cho từng người tham gia
- Có thể ghi file riêng biệt cho từng người nếu cần

### 1.5. Tích hợp UserManager để ánh xạ người dùng với audio streams
**Vấn đề hiện tại**: meetbot.js không có thông tin về người dùng.
**Giải pháp**:
- Tích hợp UserManager như trong docs để theo dõi người dùng trong meeting
- Ánh xạ streamId với deviceId của người dùng
- Ánh xạ audio track với người dùng cụ thể

### 1.6. Thay đổi cách gửi dữ liệu audio
**Vấn đề hiện tại**: meetbot.js gửi một luồng audio duy nhất.
**Giải pháp**:
- Thay đổi hàm `sendAudioChunk` để có thể gửi audio theo participantId
- Hoặc tạo một hàm mới `sendPerParticipantAudio` như trong docs
- Có thể giữ cả hai cách: mixed audio và per-participant audio

## 2. Cấu trúc thư mục lưu trữ audio tracks riêng biệt

```
recordings/
├── meeting_<meeting_id>_<timestamp>/
│   ├── mixed_audio.wav                  # Audio đã trộn (tương tự hiện tại)
│   ├── participants/
│   │   ├── <display_name>_<participant_id>/
│   │   │   ├── info.json                 # Metadata về người nói
│   │   │   ├── activity.log              # Log hoạt động của người nói
│   │   │   ├── audio_tracks/
│   │   │   │   ├── track_<display_name>_<participant_id>_<track_id>_<timestamp>.wav
│   │   │   │   └── track_<display_name>_<participant_id>_<track_id>_<timestamp>.wav
│   │   │   └── combined_<display_name>_<participant_id>.wav  # Audio kết hợp từ tất cả tracks
│   │   └── participants_summary.json    # Tổng hợp thông tin tất cả người nói
│   └── meeting_metadata.json            # Metadata về cuộc họp
```

## 3. Thiết kế hệ thống lưu trữ với metadata

### 3.1. Metadata cho từng participant (info.json)
```json
{
  "participant_id": "user123",
  "display_name": "Nguyen Van A",
  "full_name": "Nguyen Van A",
  "join_time": "2023-06-15T10:30:00Z",
  "leave_time": "2023-06-15T11:30:00Z",
  "total_speaking_time": 120000,
  "tracks": [
    {
      "track_id": "track456",
      "stream_id": "stream789",
      "start_time": "2023-06-15T10:30:05Z",
      "end_time": "2023-06-15T10:35:00Z",
      "duration": 295000
    }
  ]
}
```

### 3.2. Metadata cho meeting (meeting_metadata.json)
```json
{
  "meeting_id": "meeting_abc123",
  "meeting_url": "https://meet.google.com/abc-defg-hij",
  "start_time": "2023-06-15T10:30:00Z",
  "end_time": "2023-06-15T11:30:00Z",
  "participants": [
    {
      "participant_id": "user123",
      "display_name": "Nguyen Van A",
      "join_time": "2023-06-15T10:30:00Z",
      "leave_time": "2023-06-15T11:30:00Z"
    }
  ]
}
```

## 4. Cơ chế ghi file audio riêng biệt

### 4.1. Tạo luồng ghi file riêng biệt cho từng participant
- Tạo Map để lưu trữ write stream cho từng participant
- Tự động tạo thư mục và file khi có audio từ một participant mới

### 4.2. Đặt tên file/thư mục dễ nhận biết
- Dùng tên người nói trong tên thư mục và tên file
- Sanitize tên để đảm bảo tương thích với hệ thống file

### 4.3. Tự động tạo file combined
- Tự động tạo file audio kết hợp từ tất cả các track của một người
- Giúp dễ dàng nghe toàn bộ nội dung của từng người nói

## 5. Các cải tiến bổ sung

### 5.1. Tích hợp WebSocket để truyền dữ liệu real-time
- Cho phép truyền audio data real-time đến server
- Hỗ trợ streaming và xử lý real-time

### 5.2. Thêm tính năng phát hiện khoảng lặng
- Tự động dừng ghi âm khi không có người nói
- Giảm kích thước file và tăng hiệu suất

### 5.3. Hỗ trợ ghi chú thời gian (timestamping)
- Ghi lại thời điểm bắt đầu/kết thúc phát biểu của từng người
- Hỗ trợ tạo transcript tự động

### 5.4. Tối ưu hóa hiệu suất
- Sử dụng Web Workers để xử lý audio không chặn luồng chính
- Tối ưu hóa việc ghi file và chuyển đổi định dạng

## 6. Kế hoạch thực hiện

1. **Giai đoạn 1**: Cài đặt RTC-based audio capture (1-2 ngày)
2. **Giai đoạn 2**: Tích hợp UserManager và ReceiverManager (2-3 ngày)
3. **Giai đoạn 3**: Cài đặt MediaStreamTrackProcessor và xử lý per-participant audio (3-4 ngày)
4. **Giai đoạn 4**: Thiết kế cấu trúc thư mục và hệ thống metadata (1-2 ngày)
5. **Giai đoạn 5**: Tối ưu hóa và test (2-3 ngày)
