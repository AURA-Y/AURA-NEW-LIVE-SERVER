export class CreateRoomDto {
  userName: string;
  roomTopic?: string;
  description?: string;
  maxParticipants?: number;
}
