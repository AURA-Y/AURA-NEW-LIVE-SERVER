<p align="center">
   <img src="https://github.com/user-attachments/assets/66b6e204-1f23-4740-8e3e-2767d5476e07" alt="AURA Logo" width="278" height="231" />   
  <h1 align="center">AURA LiveKit Backend</h1>
  <p align="center"><strong>AI Voice Bot & Real-time Meeting Agent</strong></p>
</p>

---

## Overview

LiveKit 기반 화상회의 관리 및 AI 음성 봇을 담당하는 NestJS 서버입니다.

### Core Responsibilities

- LiveKit Room 생성/관리
- **AI 음성 봇** ("아우라" 웨이크워드)
- STT (Speech-to-Text) 처리
- TTS (Text-to-Speech) 처리
- RAG 서버 연동
- 화면 공유 분석 (Vision)

---

## Features

| Feature | Description |
|---------|-------------|
| **Room 관리** | 생성, 참여, 삭제, 토큰 발급 |
| **AI Voice Bot** | 웨이크워드 감지, 음성 Q&A |
| **STT** | Azure / Deepgram / Clova |
| **TTS** | Azure Speech 기반 음성 합성 |
| **RAG 연동** | WebSocket으로 RAG 서버와 통신 |
| **Vision** | 화면 캡처 분석, 이미지 Q&A |
| **회의 관리** | 시작/종료, 논점 조회, 타임라인 |

---

## Tech Stack

| Category | Technology |
|----------|------------|
| **Framework** | NestJS |
| **Language** | TypeScript |
| **LiveKit** | livekit-server-sdk, @livekit/rtc-node |
| **STT** | Azure Speech SDK, Deepgram |
| **TTS** | Azure Cognitive Services |
| **LLM** | AWS Bedrock (Claude) |
| **WebSocket** | ws |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    livekit-backend                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   ┌─────────────┐     ┌─────────────┐     ┌─────────────┐   │
│   │   LiveKit   │     │  Voice Bot  │     │    RAG      │   │
│   │   Service   │────►│   Service   │────►│   Client    │   │
│   │             │     │             │     │             │   │
│   └─────────────┘     └──────┬──────┘     └─────────────┘   │
│                              │                              │
│                   ┌──────────┼──────────┐                   │
│                   │          │          │                   │
│                   ▼          ▼          ▼                   │
│            ┌──────────┐ ┌─────────┐ ┌─────────┐             │
│            │   STT    │ │   TTS   │ │  Vision │             │
│            │ Service  │ │ Service │ │ Service │             │
│            └──────────┘ └─────────┘ └─────────┘             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
        │                   │                    │
        ▼                   ▼                    ▼
   ┌─────────┐        ┌──────────┐          ┌──────────┐
   │ LiveKit │        │   AURA   │          │    AWS   │
   │   SFU   │        │   RAG    │          │  Bedrock │
   └─────────┘        └──────────┘          └──────────┘
```

---

## Getting Started

### Prerequisites

- Node.js 18+ or Bun
- LiveKit Server (Cloud or Self-hosted)
- AURA_RAG server running

### Installation

```bash
bun install
# or
npm install
```

### Environment Variables

`.env` 파일 생성:

```env
# Server
PORT=3001

# LiveKit
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret
LIVEKIT_AGENT_NAME=aura-bot

# RAG Server
RAG_WEBSOCKET_URL=ws://localhost:8000
RAG_API_URL=http://localhost:8000

# STT Provider: azure | deepgram | clova
STT_PROVIDER=azure

# Azure Speech (if STT_PROVIDER=azure)
AZURE_SPEECH_KEY=your-azure-key
AZURE_SPEECH_REGION=koreacentral

# Deepgram (if STT_PROVIDER=deepgram)
DEEPGRAM_API_KEY=your-deepgram-key

# AWS (for Bedrock LLM)
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
AWS_REGION=ap-northeast-2

# S3 (for file uploads)
S3_BUCKET=aura-raw-data-bucket
```

### Development

```bash
bun run start:dev
# or
npm run start:dev
```

서버: http://localhost:3001

### Build & Production

```bash
bun run build
bun run start:prod
```

---

## Project Structure

```
src/
├── main.ts                     # Entry point
├── app.module.ts               # Root module
│
├── livekit/                    # LiveKit 핵심 모듈
│   ├── livekit.module.ts
│   ├── livekit.controller.ts
│   ├── livekit.service.ts      # Room 관리
│   ├── voice-bot.service.ts    # AI 봇 (매우 큼!)
│   ├── timeline.service.ts     # 타임라인 관리
│   └── dto/
│       ├── create-room.dto.ts
│       └── join-room.dto.ts
│
├── rag/                        # RAG 서버 연동
│   ├── rag.module.ts
│   ├── rag-client.service.ts   # WebSocket 클라이언트
│   └── rag-client.interface.ts
│
├── stt/                        # Speech-to-Text
│   ├── stt.module.ts
│   ├── stt.service.ts          # 메인 서비스
│   ├── clova-stt.adapter.ts
│
├── tts/                        # Text-to-Speech
│   ├── tts.module.ts
│   └── tts.service.ts
│
├── vision/                     # 화면 분석
│   ├── vision.module.ts
│   └── vision.service.ts
│
├── llm/                        # LLM 직접 호출
│   ├── llm.module.ts
│   └── llm.service.ts
│
├── intent/                     # 의도 분류
│   ├── intent.module.ts
│   └── intent-classifier.service.ts
│
├── agent/                      # 에이전트 라우팅
│   ├── agent-router.service.ts
│   ├── proactive/              # 선제적 분석
│   └── evidence/               # 근거 기반 응답
│
├── perplexity/                 # Perplexity 검색
│   ├── perplexity.module.ts
│   └── perplexity.service.ts
│
└── calendar/                   # 캘린더 연동
    ├── calendar.module.ts
    └── calendar.service.ts
```

---

## API Endpoints

### Rooms

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/rooms/create` | 방 생성 + 토큰 발급 |
| `POST` | `/rooms/join` | 방 참여 토큰 발급 |
| `GET` | `/rooms/list` | 방 목록 조회 |
| `GET` | `/rooms/:roomId` | 방 상세 조회 |
| `DELETE` | `/rooms/:roomId` | 방 삭제 |

#### POST /rooms/create

```json
// Request
{
  "userName": "홍길동",
  "roomTopic": "프로젝트 킥오프",
  "maxParticipants": 10
}

// Response
{
  "roomId": "room-1234567890-abc123",
  "roomUrl": "wss://livekit.server/room-...",
  "roomTopic": "프로젝트 킥오프",
  "maxParticipants": 10,
  "userName": "홍길동",
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "livekitUrl": "wss://livekit.server"
}
```

### Meeting Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/rooms/:roomId/embed-files` | 파일 임베딩 시작 |
| `POST` | `/rooms/:roomId/end-meeting` | 회의 종료 (요약 생성) |
| `GET` | `/rooms/:roomId/issues` | 논점 조회 |
| `GET` | `/rooms/:roomId/report` | 중간 보고서 요청 |

### Bot Control

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/rooms/:roomId/bot/start` | AI 봇 시작 |
| `POST` | `/rooms/:roomId/bot/stop` | AI 봇 종료 |
| `GET` | `/rooms/:roomId/bot/status` | 봇 상태 조회 |

### Vision

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/room/voice-bot/:roomName/vision-capture` | 화면 캡처 분석 |

---

## Voice Bot Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    Voice Bot Pipeline                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   User Audio    VAD       STT        Intent     Response    │
│       │          │         │           │            │       │
│       ▼          ▼         ▼           ▼            ▼       │
│   ┌──────┐   ┌──────┐  ┌──────┐   ┌──────┐    ┌──────┐      │
│   │Micro │──►│Voice │─►│Azure │──►│Wake  │──► │ RAG  │      │
│   │phone │   │Detect│  │Speech│   │Word? │    │Query │      │
│   └──────┘   └──────┘  └──────┘   └──────┘    └──────┘      │
│                                        │          │         │
│                                   "아우라"          |         │
│                                        │          ▼         │
│                                        │       ┌──────┐     │
│                                        └──────►│ LLM  │     │
│                                                │Answer│     │
│                                                └──────┘     │
│                                                     │       │
│                                                     ▼       │
│   Speaker   ◄────────────   TTS   ◄────────   Response      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Wake Word Detection

- 기본 웨이크워드: **"아우라"**, "아우라야", "헤이 아우라"
- 영어 발음 변형도 지원: "오라", "어라" 등
- STT 후처리로 오인식 교정

### VAD (Voice Activity Detection)

- 3초 캘리브레이션 (배경 소음 측정)
- 동적 임계값 조정
- Pre-buffer로 첫 음절 손실 방지

---

## STT Providers

| Provider | 특징 | 환경변수 |
|----------|------|----------|
| **Azure** | 한국어 우수, 안정적 | `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION` |
| **Deepgram** | 빠른 응답, 영어 우수 | `DEEPGRAM_API_KEY` |
| **Clova** | 네이버, 한국어 특화 | `CLOVA_CLIENT_SECRET` |

`STT_PROVIDER` 환경변수로 선택.

---

## Docker

### Build

```bash
docker build -t aura-livekit-backend .
```

### Run

```bash
docker run -p 3001:3001 \
  -e LIVEKIT_URL=wss://your-livekit-server \
  -e LIVEKIT_API_KEY=your-key \
  -e LIVEKIT_API_SECRET=your-secret \
  -e RAG_WEBSOCKET_URL=ws://rag-server:8000 \
  -e STT_PROVIDER=azure \
  -e AZURE_SPEECH_KEY=your-azure-key \
  -e AZURE_SPEECH_REGION=koreacentral \
  aura-livekit-backend
```

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run start:dev` | 개발 서버 (hot reload) |
| `npm run build` | 프로덕션 빌드 |
| `npm run start:prod` | 프로덕션 서버 |
| `npm run generate:grpc` | gRPC 타입 생성 |
| `npm run lint` | ESLint 실행 |

---

## Key Files

| File | Description |
|------|-------------|
| `voice-bot.service.ts` | AI 봇 핵심 로직 (2000+ lines) |
| `stt.service.ts` | STT 멀티 프로바이더 |
| `rag-client.service.ts` | RAG WebSocket 클라이언트 |
| `vision.service.ts` | 화면 분석 |

---

## Related Services

| Service | Description | Port |
|---------|-------------|------|
| **AURA_FRONT** | Next.js Frontend | 3000 |
| **livekit-backend** (this) | LiveKit Agent | 3001 |
| **api-backend** | REST API | 3002 |
| **AURA_RAG** | RAG Server | 8000 |

---

## Troubleshooting

### RAG 연결 실패

로그에서 `[RAG 연결 실패]` 확인:
- `RAG_WEBSOCKET_URL`이 `ws://` 또는 `wss://`로 시작하는지 확인
- AURA_RAG 서버가 실행 중인지 확인

### STT 작동 안 함

- `STT_PROVIDER`에 맞는 API 키가 설정되었는지 확인
- Azure: `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`
- 마이크 권한 허용 확인

### 봇이 응답하지 않음

- 웨이크워드 "아우라"를 명확하게 발음
- 배경 소음이 크면 캘리브레이션 영향
- 로그에서 `[STT 완료]` 확인

---

## License

Private
