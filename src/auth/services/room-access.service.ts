import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Room 접근 권한 검증 서비스
 * REST API의 /rooms/:roomId/access 엔드포인트를 호출하여 권한 확인
 */
@Injectable()
export class RoomAccessService {
  private readonly logger = new Logger(RoomAccessService.name);
  private readonly restApiUrl: string;

  constructor(private configService: ConfigService) {
    this.restApiUrl = this.configService.get<string>('REST_API_URL') || 'http://localhost:3002';
  }

  /**
   * 사용자가 특정 Room에 접근 권한이 있는지 확인
   * @param roomId - Room ID
   * @param userId - 사용자 ID
   * @param token - JWT 토큰 (REST API 호출용)
   * @returns 접근 가능 여부
   */
  async checkRoomAccess(roomId: string, userId: string, token: string): Promise<boolean> {
    try {
      const response = await fetch(
        `${this.restApiUrl}/restapi/rooms/${roomId}/access`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (!response.ok) {
        this.logger.warn(`Room access check failed: ${response.status} for room ${roomId}, user ${userId}`);
        return false;
      }

      const data = await response.json();
      return data.hasAccess === true;
    } catch (error) {
      this.logger.error(`Room access check error: ${error.message}`);
      // 네트워크 오류 등의 경우 보안을 위해 접근 거부
      return false;
    }
  }
}
