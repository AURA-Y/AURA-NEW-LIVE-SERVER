export class JoinRoomDto {
  roomId: string;
  userName: string;
  roomTopic?: string;  // 예약 회의 자동 생성 시 사용
}
