const assert = require('assert');
const {Request, RequestOptions} = require('./request');
const {snapshotManager} = require('@tryghost/jest-snapshot');
const {makeMessageFromMatchMessage} = require('./utils');

/**
 * @typedef {object} ExpressTestAssertion
 * @prop {function} fn - Wrapped assertion with response context
 * @prop {string} [message] - The message to display if the assertion fails
 * @prop {string} [method] - The method to call on the assertion object
 * @prop {'body' | 'header' | 'status'} type - The type of assertion, with following priority: body > header > status
 * @prop {import('assert').AssertionError} [error] - The error to throw if the assertion fails
 * @prop {any} [expected]
 * @prop {any} [expectedValue]
 * @prop {string} [expectedField]
 * @prop {object} [properties]
 */

class ExpectRequest extends Request {
    constructor(...args) {
        super(...args);

        /**
         * @property {ExpressTestAssertion[]} assertions
         */
        this.assertions = [];
    }

    expect(callback) {
        if (typeof callback !== 'function') {
            throw new Error(/* eslint-disable-line no-restricted-syntax */
                'express-test expect() requires a callback function, did you mean expectStatus or expectHeader?'
            );
        }

        const wrapperFn = (response, assertion) => {
            try {
                callback(response);
            } catch (error) {
                error.stack = assertion.error.stack.replace(assertion.error.message, error.message);
                throw error;
            }
        };

        const assertion = {
            fn: wrapperFn,
            type: 'body'
        };

        this._addAssertion(assertion);

        return this;
    }

    expectStatus(expected) {
        const assertion = {
            fn: this._assertStatus,
            expected,
            type: 'status'
        };

        this._addAssertion(assertion);

        return this;
    }

    expectHeader(expectedField, expectedValue) {
        const assertion = {
            fn: this._assertHeader,
            expectedField: expectedField.toLowerCase(),
            expectedValue,
            type: 'header'
        };

        this._addAssertion(assertion);

        return this;
    }

    matchBodySnapshot(properties = {}) {
        let assertion = {
            fn: this._assertSnapshot,
            properties: properties,
            field: 'body',
            type: 'body'
        };

        this._addAssertion(assertion);

        return this;
    }

    matchHeaderSnapshot(properties = {}) {
        let assertion = {
            fn: this._assertSnapshot,
            properties: properties,
            field: 'headers',
            type: 'header'
        };

        this._addAssertion(assertion);

        return this;
    }

    finalize(callback) {
        super.finalize((error, response) => {
            if (error) {
                return callback(error);
            }

            try {
                if (this.assertions && this.assertions.length) {
                    this._assertAll(response);
                }
                return callback(null, response);
            } catch (_error) {
                return callback(_error);
            }
        });
    }

    /**
     * @description Runs through the assertions queue and executes them
     * in following order:
     * 1. Assertions with no type, e.g: body snapshot match, generic assertions
     * 2. Assertions of "header" type
     * 3. Assertions of "status" type
     *
     * The order is here to assert the most informative assertions first and the
     * least informative ones last. For example status code assertions, usually
     * are setup first but give the least amount of information needed to
     * investigate the reason of failure. Same problem with header assertions.
     * By changing the default order of assertions it's expected to improve
     * the developer experience creating/debugging tests.
     *
     * @param {Object} response - HTTP response object
     */
    _assertAll(response) {
        const statusCodeAssertions = [];
        const headerAssertions = [];

        for (const assertion of this.assertions) {
            if (assertion.type === 'body') {
                assertion.fn(response, assertion);
            } else if (assertion.type === 'status') {
                statusCodeAssertions.push(assertion);
            } else if (assertion.type === 'header') {
                headerAssertions.push(assertion);
            } else {
                headerAssertions.push(assertion);
            }
        }

        for (const assertion of headerAssertions) {
            assertion.fn(response, assertion);
        }

        for (const assertion of statusCodeAssertions) {
            assertion.fn(response, assertion);
        }
    }

    /**
     * Adds assertion to the queue of assertions to be performed
     * @param {ExpressTestAssertion} assertion
     */
    _addAssertion(assertion) {
        // We create the error here so that we get a useful stack trace
        let error = new assert.AssertionError({
            message: 'Unexpected assertion error',
            expected: assertion.expected,
            stackStartFn: this._addAssertion
        });

        error.contextString = this.reqOptions.toString();
        assertion.error = error;

        this.assertions.push(assertion);
    }

    _assertStatus(response, assertion) {
        const {error} = assertion;

        error.message = `Expected statusCode ${assertion.expected}, got statusCode ${response.statusCode} ${error.contextString}`;

        if (response.body && response.body.errors && response.body.errors[0].message) {
            error.message += `\n${response.body.errors[0].message}`;
        }

        error.actual = response.statusCode;

        assert.equal(response.statusCode, assertion.expected, error);
    }

    _assertHeader(response, assertion) {
        const {expectedField, expectedValue, error} = assertion;
        const actual = response.headers[expectedField];

        const expectedHeaderString = `${expectedField}: ${expectedValue}`;
        const actualHeaderString = `${expectedField}: ${actual}`;

        error.expected = expectedHeaderString;
        error.actual = actualHeaderString;

        error.message = `Expected header "${expectedHeaderString}" to exist, got headers: ${JSON.stringify(response.headers)} ${error.contextString}`;
        assert.notStrictEqual(actual, undefined, error);

        if (expectedValue instanceof RegExp) {
            error.expected = expectedValue;
            error.actual = actual;
            error.message = `Expected header "${expectedField}" to have value matching "${expectedValue}", got "${actual}" ${error.contextString}`;
            assert.equal(expectedValue.test(actual), true, error);
        } else {
            error.message = `Expected header "${expectedHeaderString}", got "${actualHeaderString}" ${error.contextString}`;
            assert.equal(expectedHeaderString, actualHeaderString, error);
        }
    }

    _assertSnapshot(result, assertion) {
        const {properties, field, error} = assertion;

        if (!result[field]) {
            error.message = `Unable to match snapshot on undefined field ${field} ${error.contextString}`;
            error.expected = field;
            error.actual = 'undefined';
            assert.notEqual(result[field], undefined, error);
        }

        const hint = `[${field}]`;
        const match = snapshotManager.match(result[field], properties, hint);

        Object.keys(properties).forEach((prop) => {
            const errorMessage = `"response.${field}" is missing the expected property "${prop}"`;
            error.message = makeMessageFromMatchMessage(match.message(), errorMessage);
            error.expected = prop;
            error.actual = 'undefined';
            error.showDiff = false; // Disable mocha's diff output as it's already present in match.message()

            assert.notEqual(result[field][prop], undefined, error);
        });

        if (match.pass !== true) {
            const errorMessage = `"response.${field}" does not match snapshot.`;
            error.message = makeMessageFromMatchMessage(match.message(), errorMessage);
            error.expected = match.expected;
            error.actual = match.actual;
            error.showDiff = false; // Disable mocha's diff output as it's already present in match.message()
        }

        assert.equal(match.pass, true, error);
    }
}

module.exports = ExpectRequest;
module.exports.ExpectRequest = ExpectRequest;
module.exports.RequestOptions = RequestOptions;
