# LiveKit Backend API 명세서

**Base URL:** `http://AURA-LIVEKIT-backend-alb-2058678622.ap-northeast-2.elb.amazonaws.com/api`

## 목차
- [헬스 체크](#헬스-체크)
- [방 관리](#방-관리)
- [토큰 생성](#토큰-생성)

---

## 헬스 체크

### GET /health
서버 상태를 확인합니다.

#### Request
```bash
curl -X GET http://AURA-LIVEKIT-backend-alb-2058678622.ap-northeast-2.elb.amazonaws.com/api/health
```

#### Response
```json
{
  "status": "ok",
  "timestamp": "2025-12-30T16:21:40.876Z"
}
```

---

## 방 관리

### POST /room/create
새로운 LiveKit 방을 생성하고 생성자를 위한 토큰을 발급합니다.

#### Request
```bash
curl -X POST http://AURA-LIVEKIT-backend-alb-2058678622.ap-northeast-2.elb.amazonaws.com/api/room/create \
  -H "Content-Type: application/json" \
  -d '{
    "userName": "test-user",
    "roomTopic": "My Room",
    "description": "Test room description",
    "maxParticipants": 20
  }'
```

#### Request Body
| 필드 | 타입 | 필수 | 기본값 | 설명 |
|------|------|------|--------|------|
| `userName` | string | ✅ | - | 방 생성자의 사용자 이름 (토큰 identity로 사용됨) |
| `roomTopic` | string | ❌ | `새 회의` | 회의 주제 |
| `description` | string | ❌ | `""` | 방 설명 |
| `maxParticipants` | number | ❌ | `20` | 최대 참가자 수 |

#### Response (Success - 200)
```json
{
  "roomId": "room-1736598234-x7k2m9",
  "roomUrl": "wss://livekit.aura.ai.kr/room-1736598234-x7k2m9",
  "roomTopic": "My Room",
  "description": "Test room description",
  "maxParticipants": 20,
  "userName": "test-user",
  "token": "eyJhbGciOiJIUzI1NiJ9...",
  "livekitUrl": "wss://livekit.aura.ai.kr"
}
```

#### Response (Error - 500)
```json
{
  "statusCode": 500,
  "message": "Internal server error"
}
```

**주의:** `userName`이 누락되면 "identity is required for join but not set" 에러가 발생합니다.

---

### POST /room/join
기존 방에 참여하기 위한 토큰을 발급합니다.

#### Request
```bash
curl -X POST http://AURA-LIVEKIT-backend-alb-2058678622.ap-northeast-2.elb.amazonaws.com/api/room/join \
  -H "Content-Type: application/json" \
  -d '{
    "roomId": "RM_dSbCDo6CDPQU",
    "userName": "participant-user"
  }'
```

#### Request Body
| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `roomId` | string | ✅ | 참여할 방의 ID (sid) |
| `userName` | string | ✅ | 참가자의 사용자 이름 |

#### Response (Success - 200)
```json
{
  "token": "eyJhbGciOiJIUzI1NiJ9...",
  "url": "ws://AURA-LIVEKIT-backend-alb-2058678622.ap-northeast-2.elb.amazonaws.com"
}
```

#### Response (Error - 500)
```json
{
  "statusCode": 500,
  "message": "Internal server error"
}
```

**가능한 에러:**
- Room not found: 존재하지 않는 roomId
- identity is required: userName이 누락됨

---

### GET /room/:roomId
특정 방의 정보를 조회합니다.

#### Request
```bash
curl -X GET http://AURA-LIVEKIT-backend-alb-2058678622.ap-northeast-2.elb.amazonaws.com/api/room/RM_dSbCDo6CDPQU
```

#### Path Parameters
| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `roomId` | string | ✅ | 조회할 방의 ID (sid) |

#### Response (Success - 200)
```json
{
  "roomId": "RM_dSbCDo6CDPQU",
  "roomTopic": "test-room",
  "description": "",
  "maxParticipants": 20,
  "createdBy": "",
  "createdAt": "2025-12-30T16:22:11.000Z"
}
```

#### Response (Error - 500)
```json
{
  "statusCode": 500,
  "message": "Internal server error"
}
```

**가능한 에러:**
- Room not found: 존재하지 않는 roomId

---

### GET /rooms
모든 활성 방의 목록을 조회합니다.

#### Request
```bash
curl -X GET http://AURA-LIVEKIT-backend-alb-2058678622.ap-northeast-2.elb.amazonaws.com/api/rooms
```

#### Response (Success - 200)
```json
{
  "rooms": [
    {
      "roomId": "RM_dSbCDo6CDPQU",
      "roomTopic": "test-room",
      "description": "",
      "maxParticipants": 20,
      "createdBy": "",
      "createdAt": "2025-12-30T16:22:11.000Z"
    }
  ],
  "total": 1
}
```

---

## 토큰 생성

### POST /token
방 참여를 위한 토큰을 생성합니다. (`/room/join`과 동일한 기능)

#### Request
```bash
curl -X POST http://AURA-LIVEKIT-backend-alb-2058678622.ap-northeast-2.elb.amazonaws.com/api/token \
  -H "Content-Type: application/json" \
  -d '{
    "roomId": "RM_dSbCDo6CDPQU",
    "userName": "participant-user"
  }'
```

#### Request Body
| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `roomId` | string | ✅ | 참여할 방의 ID (sid) |
| `userName` | string | ✅ | 참가자의 사용자 이름 |

#### Response
`/room/join`과 동일

---

## 토큰 사용 방법

발급받은 토큰으로 LiveKit 클라이언트에 연결할 수 있습니다.

### JavaScript/TypeScript 예시
```typescript
import { Room } from 'livekit-client';

const room = new Room();

await room.connect('ws://AURA-LIVEKIT-backend-alb-2058678622.ap-northeast-2.elb.amazonaws.com', token, {
  audio: true,
  video: true,
});
```

### 토큰 권한
생성된 모든 토큰은 다음 권한을 가집니다:
- `roomJoin`: true
- `canPublish`: true (오디오/비디오 발행 가능)
- `canSubscribe`: true (다른 참가자 구독 가능)
- `canPublishData`: true (데이터 메시지 발행 가능)
- `ttl`: 24시간

---

## 환경 변수

서버 실행에 필요한 환경 변수:

```env
LIVEKIT_URL=http://your-livekit-server-url
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret
```

---

## 에러 코드

| HTTP 상태 | 설명 |
|-----------|------|
| 200 | 성공 |
| 500 | 서버 내부 오류 |

### 일반적인 에러 메시지

- `Failed to create room: identity is required for join but not set`
  - **원인:** `userName` 파라미터가 누락됨
  - **해결:** Request Body에 `userName` 필드를 포함시킴

- `Failed to join room: Room not found`
  - **원인:** 존재하지 않는 `roomId`
  - **해결:** 올바른 방 ID 사용 또는 `/api/rooms`로 활성 방 목록 확인

- `Failed to get room: Room not found`
  - **원인:** 존재하지 않는 `roomId`
  - **해결:** 올바른 방 ID 사용

---

## 배포 정보

- **클러스터:** AURA_LIVEKIT-cluster
- **서비스:** AURA_LIVEKIT-backend
- **ALB DNS:** AURA-LIVEKIT-backend-alb-2058678622.ap-northeast-2.elb.amazonaws.com
- **리전:** ap-northeast-2
- **이미지 태그:** 65bc1f3
- **배포일:** 2025-12-30

---

## 테스트 시나리오

### 1. 방 생성 및 참여 플로우
```bash
# 1. 방 생성
RESPONSE=$(curl -s -X POST http://AURA-LIVEKIT-backend-alb-2058678622.ap-northeast-2.elb.amazonaws.com/api/room/create \
  -H "Content-Type: application/json" \
  -d '{"userName":"host-user","roomTopic":"Test Room"}')

echo $RESPONSE | python3 -m json.tool

# roomId 추출
ROOM_ID=$(echo $RESPONSE | python3 -c "import sys, json; print(json.load(sys.stdin)['roomId'])")

# 2. 다른 사용자가 방에 참여
curl -s -X POST http://AURA-LIVEKIT-backend-alb-2058678622.ap-northeast-2.elb.amazonaws.com/api/room/join \
  -H "Content-Type: application/json" \
  -d "{\"roomId\":\"$ROOM_ID\",\"userName\":\"participant-user\"}" | python3 -m json.tool

# 3. 방 정보 조회
curl -s http://AURA-LIVEKIT-backend-alb-2058678622.ap-northeast-2.elb.amazonaws.com/api/room/$ROOM_ID | python3 -m json.tool

# 4. 전체 방 목록 조회
curl -s http://AURA-LIVEKIT-backend-alb-2058678622.ap-northeast-2.elb.amazonaws.com/api/rooms | python3 -m json.tool
```

### 2. 헬스 체크
```bash
curl -s http://AURA-LIVEKIT-backend-alb-2058678622.ap-northeast-2.elb.amazonaws.com/api/health
```

---

## 로그 확인

```bash
# CloudWatch Logs 확인
aws logs tail /ecs/aura-livekit/backend --follow

# 최근 에러 로그만 확인
aws logs tail /ecs/aura-livekit/backend --since 5m --format short | grep ERROR
```

---

## 버전 히스토리

| 버전 | 날짜 | 변경사항 |
|------|------|----------|
| 1.0.0 | 2025-12-30 | 초기 배포 |
