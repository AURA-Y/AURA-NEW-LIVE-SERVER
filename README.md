# LiveKit Backend

LiveKit Room 생성 및 토큰 발급을 위한 NestJS 백엔드 서버

## 기능

- LiveKit Room 생성
- Access Token 발급
- Room 목록 조회

## 환경 변수

`.env` 파일을 생성하고 다음 변수를 설정하세요:

```bash
LIVEKIT_URL=ws://your-livekit-server:7880
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret
PORT=3001
```

## 로컬 개발

```bash
# 의존성 설치
bun install

# 개발 모드 실행
bun run start:dev

# 빌드
bun run build

# 프로덕션 모드 실행
bun run start:prod
```

## Docker 실행

```bash
# 이미지 빌드
docker build -t livekit-backend .

# 컨테이너 실행
docker run -p 3001:3001 \
  -e LIVEKIT_URL=ws://livekit-server:7880 \
  -e LIVEKIT_API_KEY=your-key \
  -e LIVEKIT_API_SECRET=your-secret \
  livekit-backend
```

## API 엔드포인트

### POST /rooms/create
방 생성

**Request:**
```json
{
  "roomName": "test-room"
}
```

**Response:**
```json
{
  "success": true,
  "room": {
    "name": "test-room",
    "sid": "RM_xxx"
  }
}
```

### POST /rooms/join
참여 토큰 발급

**Request:**
```json
{
  "roomName": "test-room",
  "participantName": "user1"
}
```

**Response:**
```json
{
  "token": "eyJhbGc...",
  "url": "ws://livekit-server:7880"
}
```

### GET /rooms/list
Room 목록 조회

**Response:**
```json
{
  "success": true,
  "rooms": [...]
}
```
