import { Module } from '@nestjs/common';
import { StudyModeService } from './study-mode.service';
import { LlmModule } from '../llm/llm.module';

@Module({
    imports: [LlmModule],
    providers: [StudyModeService],
    exports: [StudyModeService],
})
export class StudyModule {}
