import { Module } from '@nestjs/common';
import { LivekitController, ApiController } from './livekit.controller';
import { LivekitService } from './livekit.service';
import { VoiceBotService } from './voice-bot.service';
import { TimelineService } from './timeline.service';
import { SttModule } from '../stt/stt.module';
import { LlmModule } from '../llm/llm.module';
import { TtsModule } from '../tts/tts.module';
import { RagModule } from '../rag/rag.module';
import { IntentModule } from '../intent/intent.module';
import { VisionModule } from '../vision/vision.module';
import { AgentModule } from '../agent/agent.module';
import { PerplexityModule } from '../perplexity/perplexity.module';
import { CalendarModule } from '../calendar/calendar.module';

@Module({
  imports: [SttModule, LlmModule, TtsModule, IntentModule, RagModule, VisionModule, AgentModule, PerplexityModule, CalendarModule],

  controllers: [LivekitController, ApiController],
  providers: [LivekitService, VoiceBotService, TimelineService],
  exports: [LivekitService, VoiceBotService],
})
export class LivekitModule { }

