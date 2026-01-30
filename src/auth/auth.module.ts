import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RoomAccessGuard } from './guards/room-access.guard';
import { RoomAccessService } from './services/room-access.service';

/**
 * 인증 모듈
 * - JWT 토큰 검증
 * - Room 접근 권한 확인 (REST API 연동)
 *
 * Global 모듈로 설정하여 어디서든 가드 사용 가능
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [JwtAuthGuard, RoomAccessGuard, RoomAccessService],
  exports: [JwtAuthGuard, RoomAccessGuard, RoomAccessService],
})
export class AuthModule {}
