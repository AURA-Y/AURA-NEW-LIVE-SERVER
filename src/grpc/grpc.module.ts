import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RagGrpcClientService } from './rag-grpc-client.service';

@Module({
    imports: [ConfigModule],
    providers: [RagGrpcClientService],
    exports: [RagGrpcClientService],
})
export class GrpcModule {}
