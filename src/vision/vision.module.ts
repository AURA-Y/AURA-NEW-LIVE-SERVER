import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { VisionService } from './vision.service';

@Module({
    imports: [ConfigModule],
    providers: [VisionService],
    exports: [VisionService],
})
export class VisionModule { }
