import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';

export interface JwtPayload {
  sub: string;      // userId
  nickName: string;
  iat: number;
  exp: number;
}

export interface AuthenticatedRequest extends Request {
  user: {
    userId: string;
    nickName: string;
  };
}

/**
 * JWT 인증 가드
 * REST API와 동일한 JWT_SECRET을 사용하여 토큰 검증
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('인증 토큰이 필요합니다');
    }

    try {
      const secret = this.configService.get<string>('JWT_SECRET') || 'default-secret-change-in-production';
      const payload = jwt.verify(token, secret) as JwtPayload;

      // request에 user 정보 추가
      request.user = {
        userId: payload.sub,
        nickName: payload.nickName,
      };

      return true;
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        throw new UnauthorizedException('토큰이 만료되었습니다');
      }
      throw new UnauthorizedException('유효하지 않은 토큰입니다');
    }
  }

  private extractToken(request: any): string | null {
    // 1. Authorization 헤더에서 추출
    const authHeader = request.headers?.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }

    // 2. 쿼리 파라미터에서 추출 (SSE 등)
    if (request.query?.token) {
      return request.query.token;
    }

    return null;
  }
}
