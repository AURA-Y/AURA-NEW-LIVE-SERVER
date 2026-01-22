import { Controller, Post, Body, HttpException, HttpStatus } from '@nestjs/common';
import { TranslateService, SupportedLanguage, TranslateResponse } from './translate.service';

interface TranslateRequestDto {
  text: string;
  sourceLang?: SupportedLanguage | 'auto';
  targetLang: SupportedLanguage;
}

interface TranslateBatchRequestDto {
  texts: string[];
  sourceLang?: SupportedLanguage | 'auto';
  targetLang: SupportedLanguage;
}

@Controller('translate')
export class TranslateController {
  constructor(private readonly translateService: TranslateService) {}

  /**
   * 단일 텍스트 번역
   * POST /api/translate
   */
  @Post()
  async translate(@Body() body: TranslateRequestDto): Promise<TranslateResponse> {
    const { text, sourceLang, targetLang } = body;

    if (!text) {
      throw new HttpException('text is required', HttpStatus.BAD_REQUEST);
    }

    if (!targetLang) {
      throw new HttpException('targetLang is required', HttpStatus.BAD_REQUEST);
    }

    const validLangs: SupportedLanguage[] = ['ko', 'zh', 'ja', 'en'];
    if (!validLangs.includes(targetLang)) {
      throw new HttpException(
        `targetLang must be one of: ${validLangs.join(', ')}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.translateService.translate({ text, sourceLang, targetLang });
  }

  /**
   * 여러 텍스트 일괄 번역
   * POST /api/translate/batch
   */
  @Post('batch')
  async translateBatch(@Body() body: TranslateBatchRequestDto): Promise<TranslateResponse[]> {
    const { texts, sourceLang, targetLang } = body;

    if (!texts || !Array.isArray(texts) || texts.length === 0) {
      throw new HttpException('texts array is required', HttpStatus.BAD_REQUEST);
    }

    if (!targetLang) {
      throw new HttpException('targetLang is required', HttpStatus.BAD_REQUEST);
    }

    const validLangs: SupportedLanguage[] = ['ko', 'zh', 'ja', 'en'];
    if (!validLangs.includes(targetLang)) {
      throw new HttpException(
        `targetLang must be one of: ${validLangs.join(', ')}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    // 최대 50개로 제한
    if (texts.length > 50) {
      throw new HttpException('Maximum 50 texts allowed per request', HttpStatus.BAD_REQUEST);
    }

    return this.translateService.translateBatch(texts, sourceLang, targetLang);
  }
}
