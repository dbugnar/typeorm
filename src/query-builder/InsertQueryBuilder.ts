import {QueryBuilder} from "./QueryBuilder";
import {ArrayParameter} from "./ArrayParameter";
import {ObjectLiteral} from "../common/ObjectLiteral";
import {ObjectType} from "../common/ObjectType";
import {QueryPartialEntity} from "./QueryPartialEntity";
import {SqlServerDriver} from "../driver/sqlserver/SqlServerDriver";
import {PostgresDriver} from "../driver/postgres/PostgresDriver";
import {SqliteDriver} from "../driver/sqlite/SqliteDriver";
import {MysqlDriver} from "../driver/mysql/MysqlDriver";
import {RandomGenerator} from "../util/RandomGenerator";
import {InsertResult} from "./result/InsertResult";
import {ReturningStatementNotSupportedError} from "../error/ReturningStatementNotSupportedError";
import {InsertValuesMissingError} from "../error/InsertValuesMissingError";
import {ColumnMetadata} from "../metadata/ColumnMetadata";
import {ReturningResultsEntityUpdator} from "./ReturningResultsEntityUpdator";

/**
 * Allows to build complex sql queries in a fashion way and execute those queries.
 */
export class InsertQueryBuilder<Entity> extends QueryBuilder<Entity> {

    // -------------------------------------------------------------------------
    // Public Implemented Methods
    // -------------------------------------------------------------------------

    /**
     * Gets generated sql query without parameters being replaced.
     */
    getQuery(): string {
        let sql = this.createInsertExpression();
        return sql.trim();
    }

    /**
     * Executes sql generated by query builder and returns raw database results.
     */
    async execute(): Promise<InsertResult> {
        const queryRunner = this.obtainQueryRunner();
        let transactionStartedByUs: boolean = false;

        try {

            // start transaction if it was enabled
            if (this.expressionMap.useTransaction === true && queryRunner.isTransactionActive === false) {
                await queryRunner.startTransaction();
                transactionStartedByUs = true;
            }

            const valueSets: ObjectLiteral[] = this.getValueSets();

            // call before insertion methods in listeners and subscribers
            if (this.expressionMap.callListeners === true && this.expressionMap.mainAlias!.hasMetadata) {
                await Promise.all(valueSets.map(valueSet => {
                    return queryRunner.broadcaster.broadcastBeforeInsertEvent(this.expressionMap.mainAlias!.metadata, valueSet);
                }));
            }

            // if update entity mode is enabled we may need extra columns for the returning statement
            const returningResultsEntityUpdator = new ReturningResultsEntityUpdator(queryRunner, this.expressionMap);
            if (this.expressionMap.updateEntity === true && this.expressionMap.mainAlias!.hasMetadata) {
                this.expressionMap.extraReturningColumns = returningResultsEntityUpdator.getInsertionReturningColumns();
            }

            // execute query
            const [sql, parameters] = this.getQueryAndParameters();
            const insertResult = new InsertResult();
            insertResult.raw = await queryRunner.query(sql, parameters);

            // load returning results and set them to the entity if entity updation is enabled
            if (this.expressionMap.updateEntity === true && this.expressionMap.mainAlias!.hasMetadata) {
                await returningResultsEntityUpdator.insert(insertResult, valueSets);
            }

            // call after insertion methods in listeners and subscribers
            if (this.expressionMap.callListeners === true && this.expressionMap.mainAlias!.hasMetadata) {
                await Promise.all(valueSets.map(valueSet => {
                    return queryRunner.broadcaster.broadcastAfterInsertEvent(this.expressionMap.mainAlias!.metadata, valueSet);
                }));
            }

            // close transaction if we started it
            if (transactionStartedByUs) {
                await queryRunner.commitTransaction();
            }

            return insertResult;

        } catch (error) {

            // rollback transaction if we started it
            if (transactionStartedByUs) {
                try {
                    await queryRunner.rollbackTransaction();
                } catch (rollbackError) { }
            }
            throw error;

        } finally {

            if (queryRunner !== this.queryRunner) { // means we created our own query runner
                await queryRunner.release();
            }
        }
    }

    // -------------------------------------------------------------------------
    // Public Methods
    // -------------------------------------------------------------------------

    /**
     * Specifies INTO which entity's table insertion will be executed.
     */
    into<T>(entityTarget: ObjectType<T>|string, columns?: string[]): InsertQueryBuilder<T> {
        const mainAlias = this.createFromAlias(entityTarget);
        this.expressionMap.setMainAlias(mainAlias);
        this.expressionMap.insertColumns = columns || [];
        return (this as any) as InsertQueryBuilder<T>;
    }

    /**
     * Values needs to be inserted into table.
     */
    values(values: QueryPartialEntity<Entity>|QueryPartialEntity<Entity>[]): this {
        this.expressionMap.valuesSet = values;
        return this;
    }

    /**
     * Optional returning/output clause.
     * This will return given column values.
     */
    output(columns: string[]): this;

    /**
     * Optional returning/output clause.
     * Returning is a SQL string containing returning statement.
     */
    output(output: string): this;

    /**
     * Optional returning/output clause.
     */
    output(output: string|string[]): this;

    /**
     * Optional returning/output clause.
     */
    output(output: string|string[]): this {
        return this.returning(output);
    }

    /**
     * Optional returning/output clause.
     * This will return given column values.
     */
    returning(columns: string[]): this;

    /**
     * Optional returning/output clause.
     * Returning is a SQL string containing returning statement.
     */
    returning(returning: string): this;

    /**
     * Optional returning/output clause.
     */
    returning(returning: string|string[]): this;

    /**
     * Optional returning/output clause.
     */
    returning(returning: string|string[]): this {

        // not all databases support returning/output cause
        if (!this.connection.driver.isReturningSqlSupported())
            throw new ReturningStatementNotSupportedError();

        this.expressionMap.returning = returning;
        return this;
    }

    /**
     * Indicates if entity must be updated after insertion operations.
     * This may produce extra query or use RETURNING / OUTPUT statement (depend on database).
     * Enabled by default.
     */
    updateEntity(enabled: boolean): this {
        this.expressionMap.updateEntity = enabled;
        return this;
    }

    // -------------------------------------------------------------------------
    // Protected Methods
    // -------------------------------------------------------------------------

    /**
     * Creates INSERT express used to perform insert query.
     */
    protected createInsertExpression() {

        const tableName = this.getTableName(this.getMainTableName());
        const returningExpression = this.createReturningExpression();
        const columnsExpression = this.createColumnNamesExpression();
        const valuesExpression = this.createValuesExpression();

        // generate INSERT query
        let query = `INSERT INTO ${tableName}`;

        // add columns expression
        if (columnsExpression) {
            query += `(${columnsExpression})`;
        } else {
            if (!valuesExpression && this.connection.driver instanceof MysqlDriver) // special syntax for mysql DEFAULT VALUES insertion
                query += "()";
        }

        // add OUTPUT expression
        if (returningExpression && this.connection.driver instanceof SqlServerDriver) {
            query += ` OUTPUT ${returningExpression}`;
        }

        // add VALUES expression
        if (valuesExpression) {
            query += ` VALUES ${valuesExpression}`;
        } else {
            if (this.connection.driver instanceof MysqlDriver) { // special syntax for mysql DEFAULT VALUES insertion
                query += " VALUES ()";
            } else {
                query += ` DEFAULT VALUES`;
            }
        }

        // add RETURNING expression
        if (returningExpression && this.connection.driver instanceof PostgresDriver) {
            query += ` RETURNING ${returningExpression}`;
        }

        return query;
    }

    /**
     * Gets list of columns where values must be inserted to.
     */
    protected getInsertedColumns(): ColumnMetadata[] {
        if (!this.expressionMap.mainAlias!.hasMetadata)
            return [];

        return this.expressionMap.mainAlias!.metadata.columns.filter(column => {

            // if user specified list of columns he wants to insert to, then we filter only them
            if (this.expressionMap.insertColumns.length)
                return this.expressionMap.insertColumns.indexOf(column.propertyPath);

            // if user did not specified such list then return all columns except auto-increment one
            if (column.isGenerated && column.generationStrategy === "increment")
                return false;

            return true;
        });
    }

    /**
     * Creates a columns string where values must be inserted to for INSERT INTO expression.
     */
    protected createColumnNamesExpression(): string {
        const columns = this.getInsertedColumns();
        if (columns.length > 0)
            return columns.map(column => this.escape(column.databaseName)).join(", ");

        // in the case if there are no insert columns specified and table without metadata used
        // we get columns from the inserted value map, in the case if only one inserted map is specified
        if (!this.expressionMap.mainAlias!.hasMetadata && !this.expressionMap.insertColumns.length) {
            const valueSets = this.getValueSets();
            if (valueSets.length === 1)
                return Object.keys(valueSets[0]).map(columnName => this.escape(columnName)).join(", ");
        }

        // get a table name and all column database names
        return this.expressionMap.insertColumns.map(columnName => this.escape(columnName)).join(", ");
    }

    /**
     * Creates list of values needs to be inserted in the VALUES expression.
     */
    protected createValuesExpression(): string {
        const valueSets = this.getValueSets();
        const columns = this.getInsertedColumns();

        // if column metadatas are given then apply all necessary operations with values
        if (columns.length > 0) {

            return valueSets.map((valueSet, valueSetIndex) => {
                const columnValues = columns.map(column => {
                    const paramName = "_inserted_" + valueSetIndex + "_" + column.databaseName;

                    // extract real value from the entity
                    let value = column.getEntityValue(valueSet);

                    // if column is relational and value is an object then get real referenced column value from this object
                    // for example column value is { question: { id: 1 } }, value will be equal to { id: 1 }
                    // and we extract "1" from this object
                    if (column.referencedColumn && value instanceof Object) {
                        value = column.referencedColumn.getEntityValue(value);
                    }

                    // make sure our value is normalized by a driver
                    value = this.connection.driver.preparePersistentValue(value, column);

                    // newly inserted entities always have a version equal to 1 (first version)
                    if (column.isVersion) {
                        return "1";

                    // for create and update dates we insert current date
                    // no, we don't do it because this constant is already in "default" value of the column
                    // with extended timestamp functionality, like CURRENT_TIMESTAMP(6) for example
                    // } else if (column.isCreateDate || column.isUpdateDate) {
                    //     return "CURRENT_TIMESTAMP";

                    // if column is generated uuid and database does not support its generation and custom generated value was not provided by a user - we generate a new uuid value for insertion
                    } else if (column.isGenerated && column.generationStrategy === "uuid" && !this.connection.driver.isUUIDGenerationSupported() && value === undefined) {
                        const paramName = "_uuid_" + column.databaseName + valueSetIndex;
                        this.setParameter(paramName, RandomGenerator.uuid4());
                        return ":" + paramName;

                    // if value for this column was not provided then insert default value
                    } else if (value === undefined) {
                        if (this.connection.driver instanceof SqliteDriver) { // unfortunately sqlite does not support DEFAULT expression in INSERT queries
                            if (column.default !== undefined) { // try to use default defined in the column
                                return this.connection.driver.normalizeDefault(column);
                            }
                            return "NULL"; // otherwise simply use NULL and pray if column is nullable

                        } else {
                            return "DEFAULT";
                        }

                    // support for SQL expressions in queries
                    } else if (value instanceof Function) {
                        return value();

                    // just any other regular value
                    } else {
                        if (this.connection.driver instanceof SqlServerDriver) {
                            this.setParameter(paramName, this.connection.driver.parametrizeValue(column, value));
                        } else {

                            // we need to store array values in a special class to make sure parameter replacement will work correctly
                            if (value instanceof Array)
                                value = new ArrayParameter(value);

                            this.setParameter(paramName, value);
                        }
                        return ":" + paramName;
                    }

                }).join(", ").trim();
                return columnValues ? "(" + columnValues + ")" : "";
            }).join(", ");

        } else { // for tables without metadata

            // get values needs to be inserted
            return valueSets.map((valueSet, insertionIndex) => {
                const columnValues = Object.keys(valueSet).map(columnName => {
                    const paramName = "_inserted_" + insertionIndex + "_" + columnName;
                    const value = valueSet[columnName];

                    // support for SQL expressions in queries
                    if (value instanceof Function) {
                        return value();

                    // if value for this column was not provided then insert default value
                    } else if (value === undefined) {
                        if (this.connection.driver instanceof SqliteDriver) {
                            return "NULL";

                        } else {
                            return "DEFAULT";
                        }

                    // just any other regular value
                    } else {
                        this.setParameter(paramName, value);
                        return ":" + paramName;
                    }

                }).join(", ").trim();
                return columnValues ? "(" + columnValues + ")" : "";
            }).join(", ");
        }
    }

    /**
     * Gets array of values need to be inserted into the target table.
     */
    protected getValueSets(): ObjectLiteral[] {
        if (this.expressionMap.valuesSet instanceof Array && this.expressionMap.valuesSet.length > 0)
            return this.expressionMap.valuesSet;

        if (this.expressionMap.valuesSet instanceof Object)
            return [this.expressionMap.valuesSet];

        throw new InsertValuesMissingError();
    }

}
