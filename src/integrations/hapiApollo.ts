import * as Boom from 'boom';
import { Server, Request, IReply } from 'hapi';
import { GraphQLResult, formatError } from 'graphql';
import * as GraphiQL from '../modules/renderGraphiQL';
import { runQuery } from '../core/runQuery';
import ApolloOptions from './apolloOptions';


export interface IRegister {
    (server: Server, options: any, next: any): void;
    attributes?: any;
}

export interface HAPIOptionsFunction {
  (req?: Request): ApolloOptions | Promise<ApolloOptions>;
}

export interface HAPIPluginOptions {
  path: string;
  route?: any;
  apolloOptions: ApolloOptions | HAPIOptionsFunction;
}

const ApolloHAPI: IRegister = function(server: Server, options: HAPIPluginOptions, next) {
  const config = Object.assign(options.route || {}, {
    plugins: {
      graphql: {
        options,
      },
    },
    pre: [{
      assign: 'isBatch',
      method: 'verifyPayload(payload)',
    }, {
      assign: 'graphqlParams',
      method: 'getGraphQLParams(payload, pre.isBatch)',
    }, {
      assign: 'apolloOptions',
      method: 'getApolloOptions',
    }, {
      assign: 'graphQL',
      method: 'processQuery(pre.graphqlParams, pre.apolloOptions)',
    }],
  });

  server.method('verifyPayload', verifyPayload);
  server.method('getGraphQLParams', getGraphQLParams);
  server.method('getApolloOptions', getApolloOptions);
  server.method('processQuery', processQuery);

  server.route({
    method: 'POST',
    path: options.path || '/graphql',
    config,
    handler: function(request, reply) {
      const responses = request.pre.graphQL;
      if (request.pre.isBatch) {
        return reply(responses);
      } else {
        const gqlResponse = responses[0];
        if (gqlResponse.errors && typeof gqlResponse.data === 'undefined') {
          return reply(gqlResponse).code(400);
        } else {
          return reply(gqlResponse);
        }
      }
    },
  });

  return next();
};

ApolloHAPI.attributes = {
  name: 'graphql',
  version: '0.0.1',
};

function verifyPayload(payload, reply) {
  if (!payload) {
    return reply(createErr(500, 'POST body missing.'));
  }

  // TODO: do something different here if the body is an array.
  // Throw an error if body isn't either array or object.
  reply(payload && Array.isArray(payload));
}

function getGraphQLParams(payload, isBatch, reply) {
  if (!isBatch) {
    payload = [payload];
  }

  const params = [];
  for (let query of payload) {
    let variables = query.variables;
    if (variables && typeof variables === 'string') {
      try {
        variables = JSON.parse(variables);
      } catch (error) {
        return reply(createErr(400, 'Variables are invalid JSON.'));
      }
    }

    params.push({
      query: query.query,
      variables: variables,
      operationName: query.operationName,
    });
  }
  reply(params);
};

async function getApolloOptions(request: Request, reply: IReply): Promise<{}> {
  const options = request.route.settings.plugins['graphql'].options;
  let optionsObject: ApolloOptions;
  if (isOptionsFunction(options.apolloOptions)) {
    try {
      const opsFunc: HAPIOptionsFunction = <HAPIOptionsFunction>options.apolloOptions;
      optionsObject = await opsFunc(request);
    } catch (e) {
      return reply(createErr(500, `Invalid options provided to ApolloServer: ${e.message}`));
    }
  } else {
    optionsObject = <ApolloOptions>options.apolloOptions;
  }
  reply(optionsObject);
}

async function processQuery(graphqlParams, optionsObject: ApolloOptions, reply) {
  const formatErrorFn = optionsObject.formatError || formatError;

  let responses: GraphQLResult[] = [];
  for (let query of graphqlParams) {
    try {
      let params = {
        schema: optionsObject.schema,
        query: query.query,
        variables: query.variables,
        rootValue: optionsObject.rootValue,
        context: optionsObject.context,
        operationName: query.operationName,
        logFunction: optionsObject.logFunction,
        validationRules: optionsObject.validationRules,
        formatError: formatErrorFn,
        formatResponse: optionsObject.formatResponse,
      };

      if (optionsObject.formatParams) {
        params = optionsObject.formatParams(params);
      }

      responses.push(await runQuery(params));
    } catch (e) {
      responses.push({ errors: [formatErrorFn(e)] });
    }
  }
  return reply(responses);
}

function isOptionsFunction(arg: ApolloOptions | HAPIOptionsFunction): arg is HAPIOptionsFunction {
  return typeof arg === 'function';
}

function createErr(code: number, message: string) {
  const err = Boom.create(code);
  err.output.payload.message = message;
  return err;
}

const GraphiQLHAPI: IRegister =  function(server: Server, options: GraphiQL.GraphiQLData, next) {
  server.route({
    method: 'GET',
    path: '/',
    handler: (request, reply) => {
      const q = request.query || {};
      const query = q.query || '';
      const variables = q.variables || '{}';
      const operationName = q.operationName || '';

      const graphiQLString = GraphiQL.renderGraphiQL({
        endpointURL: options.endpointURL,
        query: query || options.query,
        variables: JSON.parse(variables) || options.variables,
        operationName: operationName || options.operationName,
      });
      reply(graphiQLString).header('Content-Type', 'text/html');
    },
  });
  next();
};

GraphiQLHAPI.attributes = {
  name: 'graphiql',
  version: '0.0.1',
};

export { ApolloHAPI, GraphiQLHAPI };
