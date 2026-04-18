import { NotFoundException } from '@nestjs/common';
import { BaseSheetsRepository } from '../repositories/base.sheets.repository';
import { EntityFilterQuery, Projection, UpdateQuery } from '@database/types/query.types';
import { PublicOrmInterface } from '@database/interfaces/public.orm.interface';
import { GoogleSpreedsheetService } from '@database/services/google.spreedsheet.service';

// El "extends object" es la clave para que sea compatible con BaseSheetsRepository
export abstract class BaseCrudService<T extends object> {

  constructor(
    protected readonly repository: BaseSheetsRepository<T>,
    protected readonly repository1: GoogleSpreedsheetService
  ) { }

  /**
   * Busca un único documento, lo actualiza y devuelve el documento.
   * Por defecto devuelve el documento actualizado (new: true).
   * @param filter Filtro para encontrar el registro
   * @param update Datos a actualizar
   * @param options Opciones de actualización
   * @returns Registro actualizado
   * @example
   * const updated = await this.repository.findOneAndUpdate(
   *   { dni: '12345678' },
   *   { $set: { nombre: 'Juan', edad: 30 } }
   * );
   */
  async findOneAndUpdate(
    filter: EntityFilterQuery<T>,
    update: UpdateQuery<T>,
    options?: { new?: boolean }
  ): Promise<T | null> {
    return await this.repository.findOneAndUpdate(filter, update, options);
  }

  /**
   * Crea un nuevo registro en Google Sheets
   */
  async create(data: Partial<T>): Promise<T> {
    // Obtenemos la clase de la entidad (ObreroEntity, etc.) definida en el repo hijo
    const EntityClass = (this.repository as any).EntityClass;
    const entity = new EntityClass();

    // Mapeamos los datos recibidos a la instancia de la clase
    Object.assign(entity, data);

    await this.repository1.appendRow("123456789", "A3", entity);
    return entity;
  }

  /**
   * Retorna todos los registros de la hoja (usando caché)
   */
  async findAll(): Promise<T[]> {
    return await this.repository.findAll();
  }



  async populateAll(entity: T): Promise<T> {
    return await this.repository.populateAll(entity);
  }

  /**
   * Método de utilidad para forzar la limpieza de caché
   */
  async refreshCache(): Promise<void> {
    const cacheManager = (this.repository as any).cacheManager;
    const sheetName = (this.repository as any).sheetName;

    if (cacheManager && sheetName) {
      await cacheManager.del(`list:${sheetName}`);
      await cacheManager.del(`headers:${sheetName}`);
    }
  }

  /**
   * Elimina un registro
   */
  async remove(id: string | number): Promise<any> {
    const sheetName = (this.repository as any).sheetName || 'OBREROS';
    const identifierColumn = (this.repository as any).identifierColumn || 'id';

    const item = "asd"
    return await this.repository1.deleteRow(item, identifierColumn, 3);
  }
}