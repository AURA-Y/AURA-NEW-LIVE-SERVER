import { Module } from '@nestjs/common';
import { RagClientService } from './rag-client.service';

@Module({
    providers: [RagClientService],
    exports: [RagClientService],
})
export class RagModule { }
