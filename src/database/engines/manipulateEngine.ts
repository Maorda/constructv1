import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';

import { DateOperatorService } from '@database/services/date.operator.service';
import { OperatorsComparationsHandleUtil } from '@database/utils/operators/operators.comparations.util';
import { OperatorsMathHandleUtil } from '@database/utils/operators/operators.math.util';
import { OperatorsCollectionHandleUtil } from '@database/utils/operators/operators.collection.utils';
import { OperatorsLogicalHandleUtil } from '@database/utils/operators/operators.logical.util';
import { OperatorsDateHandleUtil } from '@database/utils/operators/operators.date.utils';
import { ValidationHandleUtil } from '@database/utils/validation.util';


@Injectable()
export class ManipulateEngine {
    private errors: string[] = [];
    private readonly logger = new Logger(ManipulateEngine.name);
    constructor(
        private readonly dateOperatorService: DateOperatorService
    ) { }
    public prepareForSave(data: any, currentRecord: any = {}): any {
        this.errors = [];
        // Clonamos para evitar efectos secundarios en el DTO original
        const clonedData = JSON.parse(JSON.stringify(data));

        const result = this.executePipeline(clonedData, currentRecord);

        if (this.errors.length > 0) {
            throw new InternalServerErrorException({
                message: 'Errores de validación o procesamiento en el motor',
                errors: this.errors,
            });
        }

        return result;
    }

    private executePipeline(obj: any, record: any): any {
        for (const key in obj) {
            const value = obj[key];

            // Si es un objeto (posible operador) y no es nulo ni arreglo
            if (value && typeof value === 'object' && !Array.isArray(value)) {

                // 1. VALIDACIÓN (Prioridad Alta)
                if (value.hasOwnProperty('$validate')) {
                    this.runValidation(key, value.value, value.$validate);
                    obj[key] = value.value; // Extraemos el valor tras validar
                    // Continuamos para ver si el valor extraído tiene más operadores
                }

                // 2. TRANSFORMACIONES DE TEXTO
                if (value.hasOwnProperty('$toUpper')) {
                    const base = value.$toUpper.startsWith('$') ? record[value.$toUpper.slice(1)] : value.$toUpper;
                    obj[key] = String(base || '').toUpperCase();
                    continue;
                }
                if (value.hasOwnProperty('$trim')) {
                    const base = value.$trim.startsWith('$') ? record[value.$trim.slice(1)] : value.$trim;
                    obj[key] = String(base || '').trim();
                    continue;
                }

                // 3. OPERADORES MATEMÁTICOS
                if (value.hasOwnProperty('$inc')) {
                    obj[key] = OperatorsMathHandleUtil.MathHandlers.increment(record[key], value.$inc);
                    continue;
                }
                if (value.hasOwnProperty('$mul')) {
                    obj[key] = OperatorsMathHandleUtil.MathHandlers.multiply(record[key], value.$mul);
                    continue;
                }
                if (value.hasOwnProperty('$math')) {
                    obj[key] = OperatorsMathHandleUtil.MathHandlers.math(value.$math, record);
                    continue;
                }
                if (value.hasOwnProperty('$round')) {
                    // Si $round viene como objeto { val: ..., precision: ... }
                    const valToRound = typeof value.$round === 'object' ? value.$round.val : value.$round;
                    obj[key] = OperatorsMathHandleUtil.MathHandlers.round(valToRound, value.$round.precision);
                    continue;
                }

                // 4. OPERADORES DE COLECCIÓN (Agregaciones)
                if (value.hasOwnProperty('$sum')) {
                    obj[key] = OperatorsCollectionHandleUtil.CollectionHandlers.aggregate(value.$sum, 'sum');
                    continue;
                }
                if (value.hasOwnProperty('$avg')) {
                    obj[key] = OperatorsCollectionHandleUtil.CollectionHandlers.aggregate(value.$avg, 'avg');
                    continue;
                }

                // 5. OPERADORES DE FECHA
                if (value.hasOwnProperty('$dateAdd')) {
                    obj[key] = OperatorsDateHandleUtil.dateAdd(record, value.$dateAdd);
                    continue;
                }

                // 6. LÓGICA CONDICIONAL ($if)
                if (value.hasOwnProperty('$if')) {
                    const conditionResult = this.evaluateCondition(value.$if, record);
                    const finalValue = conditionResult ? value.then : value.else;

                    // Si el resultado del $if es OTRO operador, lo procesamos recursivamente
                    obj[key] = (typeof finalValue === 'object')
                        ? this.executePipeline({ [key]: finalValue }, record)[key]
                        : finalValue;
                    continue;
                }

                // RECURSIVIDAD: Si llegamos aquí y sigue siendo un objeto, profundizamos
                obj[key] = this.executePipeline(value, record);
            }
        }
        return obj;
    }

    private evaluateCondition(condition: any, record: any): boolean {
        // Implementación de lógica de comparación (Usando ComparisonHandlers)
        // Aquí invocarías a tus ComparisonHandlers.after, nin, etc.
        return OperatorsLogicalHandleUtil.LogicHandlers.conditional(condition, record);
    }

    private runValidation(fieldName: string, currentVal: any, config: any) {
        // 1. Validación de Obligatoriedad (Required)
        if (config.required) {
            const res = ValidationHandleUtil.ValidationHandlers.required(currentVal);
            if (typeof res === 'string') {
                this.errors.push(`${fieldName}: ${res}`);
                return; // Si es requerido y no está, no tiene sentido validar lo demás
            }
        }

        // Si el valor es nulo o indefinido y no es requerido, saltamos las demás validaciones
        if (currentVal === null || currentVal === undefined || currentVal === '') return;

        // 2. Validación de Valor Mínimo (min)
        if (config.min !== undefined) {
            const res = ValidationHandleUtil.ValidationHandlers.min(currentVal, config.min);
            if (typeof res === 'string') this.errors.push(`${fieldName}: ${res}`);
        }

        // 3. Validación de Valor Máximo (max)
        if (config.max !== undefined) {
            const res = ValidationHandleUtil.ValidationHandlers.max(currentVal, config.max);
            if (typeof res === 'string') this.errors.push(`${fieldName}: ${res}`);
        }

        // 4. Validación de Longitud de Texto (minLength / maxLength)
        if (config.minLength !== undefined) {
            if (String(currentVal).length < config.minLength) {
                this.errors.push(`${fieldName}: Debe tener al menos ${config.minLength} caracteres.`);
            }
        }

        if (config.maxLength !== undefined) {
            if (String(currentVal).length > config.maxLength) {
                this.errors.push(`${fieldName}: No puede superar los ${config.maxLength} caracteres.`);
            }
        }

        // 5. Validación de Formato Email
        if (config.email) {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(String(currentVal))) {
                this.errors.push(`${fieldName}: El formato de correo electrónico no es válido.`);
            }
        }

        // 6. Validación de Patrón Personalizado (Regex)
        if (config.pattern && config.pattern instanceof RegExp) {
            if (!config.pattern.test(String(currentVal))) {
                this.errors.push(`${fieldName}: El valor no cumple con el formato requerido.`);
            }
        }

        // 7. Validación de Opciones Permitidas (enum / matches)
        if (config.in && Array.isArray(config.in)) {
            if (!config.in.includes(currentVal)) {
                this.errors.push(`${fieldName}: El valor debe ser uno de los siguientes: ${config.in.join(', ')}.`);
            }
        }
        // 8. VALIDACIÓN DE FECHA (isDate)
        if (config.isDate) {
            const date = new Date(currentVal);
            if (isNaN(date.getTime())) {
                this.errors.push(`${fieldName}: No es una fecha válida.`);
            }
        }

        // 9. VALIDACIÓN DE MONEDA PERUANA (Soles)
        // Verifica que sea un número positivo y, opcionalmente, con máximo 2 decimales
        if (config.isSoles) {
            const num = Number(currentVal);
            if (isNaN(num)) {
                this.errors.push(`${fieldName}: El monto debe ser un número válido.`);
            } else if (num < 0) {
                this.errors.push(`${fieldName}: El monto en Soles no puede ser negativo.`);
            }

            // Opcional: Validar que no tenga más de 2 decimales (céntimos)
            const parts = String(currentVal).split('.');
            if (parts[1] && parts[1].length > 2) {
                this.errors.push(`${fieldName}: El monto no puede tener más de 2 céntimos.`);
            }
        }
    }

}