import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RagClientService } from './rag-client.service';
// import { RagGrpcClientService } from '../grpc/rag-grpc-client.service';
import { RAG_CLIENT } from './rag-client.interface';

/**
 * RAG 모듈
 * 환경 변수 RAG_CLIENT_TYPE에 따라 WebSocket 또는 gRPC 클라이언트 선택
 * - 'grpc': gRPC 클라이언트 사용 (기본값)
 * - 'websocket' | 'ws': WebSocket 클라이언트 사용
 */
@Module({
    imports: [ConfigModule],
    providers: [
        // 기존 서비스들 (직접 주입용)
        RagClientService,
        // RagGrpcClientService,

        // 추상화된 RAG 클라이언트 (환경 변수 기반 선택)
        {
            provide: RAG_CLIENT,
            useFactory: (configService: ConfigService, wsClient: RagClientService) => {
                const clientType = configService.get<string>('RAG_CLIENT_TYPE') || 'websocket';

                // if (clientType === 'grpc') {
                //     console.log('[RAG Module] gRPC 클라이언트 사용');
                //     return grpcClient;
                // }

                console.log('[RAG Module] WebSocket 클라이언트 사용');
                return wsClient;
            },
            inject: [ConfigService, RagClientService],
        },
    ],
    exports: [
        RagClientService,      // 기존 호환성 유지
        // RagGrpcClientService,  // gRPC 직접 사용 가능
        RAG_CLIENT,            // 추상화된 클라이언트
    ],
})
export class RagModule { }
