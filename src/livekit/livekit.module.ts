import { Module } from '@nestjs/common';
import { LivekitController, ApiController } from './livekit.controller';
import { LivekitService } from './livekit.service';
import { VoiceBotService } from './voice-bot.service';
import { SttModule } from '../stt/stt.module';
// import { LlmModule } from '../llm/llm.module'; // RAG로 대체
import { TtsModule } from '../tts/tts.module';
import { RagModule } from '../rag/rag.module';

@Module({
  imports: [SttModule, /* LlmModule, */ TtsModule, RagModule],
  controllers: [LivekitController, ApiController],
  providers: [LivekitService, VoiceBotService],
  exports: [LivekitService],
})
export class LivekitModule { }


