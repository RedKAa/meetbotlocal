# meetbotlocal
Join meet, save rec file in server, leave meet

### install and run
`npm i`

change `meetingUrl` in test.ts

## run
`npm run test`

# Meet Recorder

Script tự động tham gia cuộc họp Google Meet và ghi âm/ghi hình cuộc họp, sau đó lưu file vào thư mục `recordings`.

## Cách sử dụng

### Cài đặt dependencies

```bash
npm install
```

### Chạy script

```bash
# Chạy với URL cuộc họp và tên bot mặc định
npm run record https://meet.google.com/xxx-xxx-xxx

# Chạy với URL cuộc họp và tên bot tùy chỉnh, get transcript
npm run tran https://meet.google.com/xxx-xxx-xxx "HopFast"

```
