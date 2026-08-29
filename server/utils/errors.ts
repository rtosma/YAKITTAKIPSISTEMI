export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly details?: any;

  constructor(message: string, statusCode: number = 500, isOperational: boolean = true, details?: any) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace(this, this.constructor);
  }
}

export class BadRequestError extends AppError {
  constructor(message: string = 'Geçersiz istek', details?: any) {
    super(message, 400, true, details);
  }
}

export class ValidationError extends AppError {
  constructor(message: string = 'Girdi doğrulama hatası', details?: any) {
    super(message, 400, true, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = 'Kimlik doğrulaması başarısız', details?: any) {
    super(message, 401, true, details);
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = 'Bu işlem için yetkiniz bulunmamaktadır', details?: any) {
    super(message, 403, true, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = 'Aranan kaynak bulunamadı', details?: any) {
    super(message, 404, true, details);
  }
}

export class ConflictError extends AppError {
  constructor(message: string = 'Çakışma oluştu', details?: any) {
    super(message, 409, true, details);
  }
}

export class InternalServerError extends AppError {
  constructor(message: string = 'Sunucu hatası oluştu', details?: any) {
    super(message, 500, false, details);
  }
}
