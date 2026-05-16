import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
    PORT: Joi.number().default(3000),
    NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),

    // Configuración de Google
    GOOGLE_PROJECT_ID: Joi.string().required(),
    GOOGLE_PRIVATE_KEY_ID: Joi.string().required(),
    GOOGLE_PRIVATE_KEY: Joi.string().required(),
    GOOGLE_CLIENT_EMAIL: Joi.string().email().required(),
    GOOGLE_CLIENT_ID: Joi.string().required(),

    // IDs de Negocio exactos de tu .env
    GOOGLE_FOLDER_ID: Joi.string().required(),
    SPREADSHEET_ID: Joi.string().required(), // <-- Clave idéntica a tu .env

    // Configuración regional
    TIMEZONE: Joi.string().default('America/Lima'),
    FORMAT_DATES: Joi.boolean().default(false),
});