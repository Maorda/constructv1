export class ValidationHandleUtil {
    /**
         * HANDLERS DE VALIDACIÓN
         * Verifican la integridad de los datos procesados.
         */
    static ValidationHandlers = {
        required: (val: any) => (val !== undefined && val !== null && val !== '') || 'Este campo es obligatorio',
        isNumber: (val: any) => !isNaN(Number(val)) || 'Debe ser un valor numérico',
        min: (val: any, min: number) => Number(val) >= min || `El valor mínimo es ${min}`,
        max: (val: any, max: number) => Number(val) <= max || `El valor máximo es ${max}`,
        enum: (val: any, options: any[]) => options.includes(val) || `Valor no permitido. Opciones: ${options.join(', ')}`,
        // Validación personalizada mediante una condición lógica
        custom: (isValid: boolean, message: string) => isValid || message
    };
}
