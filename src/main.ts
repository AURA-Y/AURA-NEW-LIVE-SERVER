import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { json, urlencoded } from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Body parser 크기 제한 증가 (Vision 캡처용 - 최대 10MB)
  app.use(json({ limit: '10mb' }));
  app.use(urlencoded({ limit: '10mb', extended: true }));

  // Global prefix 설정
  app.setGlobalPrefix('api');

  // CORS 설정
  app.enableCors({
    origin: ['http://localhost:3000', 'https://aura.ai.kr'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });

  const port = process.env.PORT || 3001;
  await app.listen(port);
  console.log(`Backend server is running on http://localhost:${port}/api`);
}

bootstrap();
