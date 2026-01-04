import { Module } from '@nestjs/common';
import { IntentClassifierService } from './intent-classifier.service';

@Module({
    providers: [IntentClassifierService],
    exports: [IntentClassifierService],
})
export class IntentModule {}
