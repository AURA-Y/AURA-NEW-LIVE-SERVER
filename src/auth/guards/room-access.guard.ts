import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { RoomAccessService } from '../services/room-access.service';

interface JwtPayload {
  sub: string;
  nickName: string;
  iat: number;
  exp: number;
}

/**
 * Room 접근 권한 검증 가드
 * 1. JWT 토큰 검증
 * 2. REST API를 통해 Room 접근 권한 확인
 *
 * 사용법: @UseGuards(RoomAccessGuard)
 * 요청 body에 roomId가 있어야 함
 */
@Injectable()
export class RoomAccessGuard implements CanActivate {
  constructor(
    private configService: ConfigService,
    private roomAccessService: RoomAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = this.extractToken(request);

    // 1. JWT 토큰 검증
    if (!token) {
      throw new UnauthorizedException('인증 토큰이 필요합니다');
    }

    let payload: JwtPayload;
    try {
      const secret = this.configService.get<string>('JWT_SECRET') || 'default-secret-change-in-production';
      payload = jwt.verify(token, secret) as JwtPayload;
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        throw new UnauthorizedException('토큰이 만료되었습니다');
      }
      throw new UnauthorizedException('유효하지 않은 토큰입니다');
    }

    // request에 user 정보 추가
    request.user = {
      userId: payload.sub,
      nickName: payload.nickName,
    };

    // 2. Room 접근 권한 확인
    const roomId = request.body?.roomId;
    if (!roomId) {
      throw new UnauthorizedException('roomId가 필요합니다');
    }

    const hasAccess = await this.roomAccessService.checkRoomAccess(
      roomId,
      payload.sub,
      token,
    );

    if (!hasAccess) {
      throw new ForbiddenException('이 방에 대한 접근 권한이 없습니다');
    }

    return true;
  }

  private extractToken(request: any): string | null {
    const authHeader = request.headers?.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }
    if (request.query?.token) {
      return request.query.token;
    }
    return null;
  }
}
