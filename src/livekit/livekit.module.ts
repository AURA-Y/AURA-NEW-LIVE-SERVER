import { Module } from "@nestjs/common";
import { LivekitController, ApiController } from "./livekit.controller";
import { LivekitService } from "./livekit.service";
import { VoiceBotService } from "./voice-bot.service";
import { SttModule } from "../stt/stt.module";
import { LlmModule } from "../llm/llm.module";
import { TtsModule } from "../tts/tts.module";
import { RagModule } from "../rag/rag.module";
import { IntentModule } from "../intent/intent.module";
import { VisionModule } from "../vision/vision.module";

import { WebhookController } from "./webhook.controller";

@Module({
  imports: [
    SttModule,
    LlmModule,
    TtsModule,
    IntentModule,
    RagModule,
    VisionModule,
  ],

  controllers: [LivekitController, ApiController, WebhookController],
  providers: [LivekitService, VoiceBotService],
  exports: [LivekitService],
})
export class LivekitModule {}
