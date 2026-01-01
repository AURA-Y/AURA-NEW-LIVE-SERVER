# AURA Voice AI Server

LiveKit 기반 실시간 음성 AI 회의 서버

## 개요

이 프로젝트는 LiveKit WebRTC 서버와 AWS AI 서비스(Transcribe, Bedrock, Polly)를 통합하여 실시간 음성 AI 회의를 제공합니다.

## 주요 기능

- **실시간 화상/음성 회의** - LiveKit 기반
- **음성→텍스트 (STT)** - AWS Transcribe Streaming
- **AI 응답 생성 (LLM)** - AWS Bedrock (Claude)
- **텍스트→음성 (TTS)** - AWS Polly (Neural)
- **AI 음성 봇** - 회의 참여 및 실시간 음성 응답

## 아키텍처

```
사용자 (마이크) → LiveKit Room → AI Bot
                                  ↓
                           AudioStream (16kHz PCM)
                                  ↓
                           AWS Transcribe (STT)
                                  ↓
                           AWS Bedrock Claude (LLM)
                                  ↓
                           AWS Polly (TTS)
                                  ↓
                           LiveKit Room → 사용자 (스피커)
```

## 프로젝트 구조

```
src/
├── livekit/           # LiveKit 방 관리 및 AI 봇
│   ├── dto/
│   ├── livekit.controller.ts
│   ├── livekit.module.ts
│   ├── livekit.service.ts
│   └── voice-bot.service.ts
├── stt/               # 음성→텍스트 (AWS Transcribe)
│   ├── stt.module.ts
│   └── stt.service.ts
├── llm/               # LLM (AWS Bedrock Claude)
│   ├── llm.module.ts
│   └── llm.service.ts
├── tts/               # 텍스트→음성 (AWS Polly)
│   ├── tts.module.ts
│   └── tts.service.ts
├── app.module.ts
└── main.ts
```

## 시작하기

### 1. 환경 변수 설정

`.env` 파일 생성:

```bash
# LiveKit
LIVEKIT_URL=http://localhost:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret

# AWS (Transcribe, Bedrock, Polly)
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=ap-northeast-2
```

### 2. 의존성 설치

```bash
npm install
```

### 3. LiveKit 서버 실행

```bash
docker compose up livekit
```

### 4. 개발 서버 실행

```bash
npm run start:dev
```

## API 문서

자세한 API 문서는 [API.md](./API.md) 참조

## 서비스 상세

각 서비스 설명은 [SERVICES.md](./SERVICES.md) 참조

## 아키텍처 상세

아키텍처 상세 설명은 [ARCHITECTURE.md](./ARCHITECTURE.md) 참조
