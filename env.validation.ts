import * as Joi from 'joi';
export const envValidationSchema = Joi.object({
    PORT: Joi.number().default(3000),
    // Configuración de Google
    GOOGLE_PROJECT_ID: Joi.string().required(),
    GOOGLE_PRIVATE_KEY: Joi.string().required(),
    GOOGLE_CLIENT_EMAIL: Joi.string().email().required(),
    GOOGLE_CLIENT_ID: Joi.string().required(),
    //GOOGLE_CLIENT_CERT_URL: Joi.string().uri().required(),
    // IDs de Negocio
    GOOGLE_FOLDER_ID: Joi.string().required(),
    SPREADSHEET_ID: Joi.string().required(),
    NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
});