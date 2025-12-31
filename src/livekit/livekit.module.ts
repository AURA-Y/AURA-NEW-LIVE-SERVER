import { Module } from '@nestjs/common';
import { LivekitController, ApiController } from './livekit.controller';
import { LivekitService } from './livekit.service';

@Module({
  controllers: [LivekitController, ApiController],
  providers: [LivekitService],
  exports: [LivekitService],
})
export class LivekitModule {}
