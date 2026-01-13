import { Module } from '@nestjs/common';
import { RecordingController } from './recording.controller';
import { RecordingService } from './recording.service';

@Module({
  controllers: [RecordingController],
  providers: [RecordingService],
  exports: [RecordingService],
})
export class RecordingModule {}
