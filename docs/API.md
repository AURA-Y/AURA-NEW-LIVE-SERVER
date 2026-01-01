# API 엔드포인트

Base URL: `http://localhost:3001/api`

---

## 🏠 방 관리

### 방 생성

```http
POST /api/room/create
```

**Request Body:**
```json
{
  "userName": "홍길동",
  "roomTitle": "회의실1",
  "maxParticipants": 10
}
```

**Response:**
```json
{
  "roomId": "RM_xxxxx",
  "roomTitle": "회의실1",
  "token": "eyJhbGciOiJ...",
  "livekitUrl": "ws://localhost:7880"
}
```

---

### 방 입장

```http
POST /api/room/join
```

**Request Body:**
```json
{
  "roomName": "회의실1",
  "userName": "참가자1"
}
```

**Response:**
```json
{
  "token": "eyJhbGciOiJ...",
  "url": "ws://localhost:7880"
}
```

---

### 방 목록 조회

```http
GET /api/rooms
```

**Response:**
```json
{
  "rooms": [
    {
      "roomId": "RM_xxxxx",
      "roomTitle": "회의실1",
      "maxParticipants": 10
    }
  ],
  "total": 1
}
```

---

## 🤖 AI 음성 봇

### 봇 시작

```http
POST /api/room/voice-bot/{roomName}
```

**Response:**
```json
{
  "success": true,
  "message": "AI 봇이 방 '회의실1'에 입장했습니다.",
  "roomName": "회의실1"
}
```

---

### 봇 종료

```http
DELETE /api/room/voice-bot/{roomName}
```

**Response:**
```json
{
  "success": true,
  "message": "AI 봇이 방 '회의실1'에서 퇴장했습니다."
}
```

---

### 봇 상태 확인

```http
GET /api/room/voice-bot/{roomName}/status
```

**Response:**
```json
{
  "roomName": "회의실1",
  "active": true
}
```

---

## 🧪 테스트용 엔드포인트

### STT 테스트 (파일 업로드)

```http
POST /api/room/stt-test
Content-Type: multipart/form-data
```

**Request:**
- `audio`: PCM 오디오 파일 (16kHz, 모노)

**Response:**
```json
{
  "success": true,
  "transcript": "안녕하세요"
}
```

---

### STT + LLM 테스트

```http
POST /api/room/stt-llm-test
Content-Type: multipart/form-data
```

**Request:**
- `audio`: PCM 오디오 파일

**Response:**
```json
{
  "success": true,
  "transcript": "안녕하세요",
  "llmResponse": "안녕하세요! 무엇을 도와드릴까요?"
}
```

---

### 전체 파이프라인 테스트 (STT + LLM + TTS)

```http
POST /api/room/voice-chat
Content-Type: multipart/form-data
```

**Request:**
- `audio`: PCM 오디오 파일

**Response:**
- Content-Type: `audio/mpeg`
- Body: MP3 오디오 데이터

**Response Headers:**
```
X-Latency-Total: 8500
X-Latency-STT: 4500
X-Latency-LLM: 2800
X-Latency-TTS: 1200
X-Transcript: %EC%95%88%EB%85%95%ED%95%98%EC%84%B8%EC%9A%94
```

---

### TTS 테스트

```http
POST /api/room/tts-test
Content-Type: application/json
```

**Request Body:**
```json
{
  "text": "안녕하세요, TTS 테스트입니다."
}
```

**Response:**
- Content-Type: `audio/mpeg`
- Body: MP3 오디오 데이터

---

## ⚙️ 헬스 체크

```http
GET /api/health
```

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-12-31T12:00:00.000Z"
}
```
