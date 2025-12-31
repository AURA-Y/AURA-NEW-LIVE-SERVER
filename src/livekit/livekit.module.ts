import { Module } from '@nestjs/common';
import { LivekitController, ApiController } from './livekit.controller';
import { LivekitService } from './livekit.service';
import { VoiceBotService } from './voice-bot.service';
import { SttModule } from '../stt/stt.module';
import { LlmModule } from '../llm/llm.module';
import { TtsModule } from '../tts/tts.module';

@Module({
  imports: [SttModule, LlmModule, TtsModule],
  controllers: [LivekitController, ApiController],
  providers: [LivekitService, VoiceBotService],
  exports: [LivekitService],
})
export class LivekitModule { }


