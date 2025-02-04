import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { NetworkLoadBalancedTaskImageOptions } from 'aws-cdk-lib/aws-ecs-patterns';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
//import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudMap from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';
import { AuthProvider } from './supabase-auth-provider';
import { SupabaseDatabase } from './supabase-db';
import { FargateStack } from './supabase-stack';

interface SupabaseTaskImageOptions extends NetworkLoadBalancedTaskImageOptions {
  containerPort: number;
  healthCheck?: ecs.HealthCheck;
  command?: string[];
}

export interface BaseFargateServiceProps {
  serviceName?: string;
  cluster: ecs.ICluster;
  taskImageOptions: SupabaseTaskImageOptions;
  cpuArchitecture?: 'X86_64'|'ARM64';
  enableServiceConnect?: boolean;
  enableCloudMap?: boolean;
}

export interface AutoScalingFargateServiceProps extends BaseFargateServiceProps {
  minTaskCount?: number;
  maxTaskCount?: number;
}

export interface TargetGroupProps {
  healthCheck?: elb.HealthCheck;
}

export class BaseFargateService extends Construct {
  /**
   * The URL to connect to an API. The URL contains the protocol, a DNS name, and the port.
   * (e.g. `http://rest.supabase.internal:8000`)
   */
  readonly endpoint: string;
  readonly service: ecs.FargateService;
  readonly connections: ec2.Connections;

  constructor(scope: Construct, id: string, props: BaseFargateServiceProps) {
    super(scope, id);

    const serviceName = props.serviceName || id.toLowerCase();
    const { cluster, taskImageOptions } = props;
    const containerPort = taskImageOptions.containerPort;
    const cpuArchitecture = (props.cpuArchitecture == 'X86_64') ? ecs.CpuArchitecture.X86_64 : ecs.CpuArchitecture.ARM64;
    const enableServiceConnect = (typeof props.enableServiceConnect == 'undefined') ? true : props.enableServiceConnect;
    const enableCloudMap = (typeof props.enableCloudMap == 'undefined') ? true : props.enableCloudMap;

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      runtimePlatform: {
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        cpuArchitecture,
      },
    });

    const logGroup = new logs.LogGroup(this, 'Logs', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: logs.RetentionDays.ONE_MONTH,
    });

    const logDriver = new ecs.AwsLogDriver({ logGroup, streamPrefix: 'ecs' });

    const containerName = taskImageOptions.containerName ?? 'app';
    const appContainer = taskDefinition.addContainer(containerName, {
      image: taskImageOptions.image,
      logging: logDriver,
      environment: taskImageOptions.environment,
      secrets: taskImageOptions.secrets,
      dockerLabels: taskImageOptions.dockerLabels,
      healthCheck: taskImageOptions.healthCheck,
      command: taskImageOptions.command,
    });
    appContainer.addUlimits({ name: ecs.UlimitName.NOFILE, softLimit: 65536, hardLimit: 65536 });
    appContainer.addPortMappings({ name: 'http', containerPort: taskImageOptions.containerPort });

    this.service = new ecs.FargateService(this, 'Fargate', {
      cluster,
      taskDefinition,
      circuitBreaker: { rollback: true },
      enableECSManagedTags: true,
      propagateTags: ecs.PropagatedTagSource.SERVICE,
    });

    if (enableServiceConnect) {
      this.service.enableServiceConnect({
        services: [{
          portMappingName: 'http',
          discoveryName: serviceName,
        }],
        logDriver,
      });
    }

    if (enableCloudMap) {
      const cloudMapService = this.service.enableCloudMap({
        cloudMapNamespace: cluster.defaultCloudMapNamespace,
        name: serviceName,
        container: appContainer,
        dnsRecordType: cloudMap.DnsRecordType.SRV,
        dnsTtl: cdk.Duration.seconds(10),
      });
      (cloudMapService.node.defaultChild as cloudMap.CfnService).addPropertyOverride('DnsConfig.DnsRecords.1', { Type: 'A', TTL: 10 });
    }

    this.connections = new ec2.Connections({
      defaultPort: ec2.Port.tcp(containerPort),
      securityGroups: this.service.connections.securityGroups,
    });

    this.endpoint = `http://${serviceName}.${cluster.defaultCloudMapNamespace?.namespaceName}:${containerPort}`;
  }

  addTargetGroup(props?: TargetGroupProps) {
    const targetGroup = new elb.ApplicationTargetGroup(this, 'TargetGroup', {
      protocol: elb.ApplicationProtocol.HTTP,
      port: Number(this.connections.defaultPort),
      targets: [this.service.loadBalancerTarget({ containerName: 'app' })],
      deregistrationDelay: cdk.Duration.seconds(30),
      healthCheck: props?.healthCheck,
      vpc: this.service.cluster.vpc,
    });
    return targetGroup;
  }

  connectDatabase(database: SupabaseDatabase) {
    this.service.connections.allowToDefaultPort(database.cluster);
    this.service.node.defaultChild?.node.addDependency(database.cluster.node.findChild('Instance1'));
  }

  addExternalAuthProviders(redirectUri: string, providerCount: number) {
    const providers: AuthProvider[] = [];
    for (let i = 0; i < providerCount; i++) {
      const authProvider = new AuthProvider(this, `Provider${i+1}`);
      const container = this.service.taskDefinition.defaultContainer!;
      // Set environment variables
      container.addEnvironment(`GOTRUE_EXTERNAL_${authProvider.id}_ENABLED`, authProvider.enabled);
      container.addEnvironment(`GOTRUE_EXTERNAL_${authProvider.id}_REDIRECT_URI`, redirectUri);
      container.addSecret(`GOTRUE_EXTERNAL_${authProvider.id}_CLIENT_ID`, ecs.Secret.fromSsmParameter(authProvider.clientIdParameter));
      container.addSecret(`GOTRUE_EXTERNAL_${authProvider.id}_SECRET`, ecs.Secret.fromSsmParameter(authProvider.secretParameter));
      providers.push(authProvider);
    }
    return providers;
  }
}

export class AutoScalingFargateService extends BaseFargateService {
  readonly cfnParameters: {
    taskSize: cdk.CfnParameter;
    minTaskCount: cdk.CfnParameter;
    maxTaskCount: cdk.CfnParameter;
  };
  constructor(scope: FargateStack, id: string, props: AutoScalingFargateServiceProps) {
    super(scope, id, props);

    const { minTaskCount, maxTaskCount } = props;

    this.cfnParameters = {
      taskSize: new cdk.CfnParameter(this, 'TaskSize', {
        description: 'Fargare task size',
        type: 'String',
        default: 'micro',
        allowedValues: ['micro', 'small', 'medium', 'large', 'xlarge', '2xlarge', '4xlarge'],
      }),
      minTaskCount: new cdk.CfnParameter(this, 'MinTaskCount', {
        description: 'Minimum fargate task count',
        type: 'Number',
        default: (typeof minTaskCount == 'undefined') ? 1 : minTaskCount,
        minValue: 0,
      }),
      maxTaskCount: new cdk.CfnParameter(this, 'MaxTaskCount', {
        description: 'Maximum fargate task count',
        type: 'Number',
        default: (typeof maxTaskCount == 'undefined') ? 20 : maxTaskCount,
        minValue: 0,
      }),
    };

    const cpu = scope.taskSizeMapping.findInMap(this.cfnParameters.taskSize.valueAsString, 'cpu');
    const memory = scope.taskSizeMapping.findInMap(this.cfnParameters.taskSize.valueAsString, 'memory');

    (this.service.taskDefinition.node.defaultChild as ecs.CfnTaskDefinition).addPropertyOverride('Cpu', cpu);
    (this.service.taskDefinition.node.defaultChild as ecs.CfnTaskDefinition).addPropertyOverride('Memory', memory);

    const serviceDisabled = new cdk.CfnCondition(this, 'ServiceDisabled', { expression: cdk.Fn.conditionEquals(this.cfnParameters.minTaskCount, '0') });
    (this.service.node.defaultChild as ecs.CfnService).addPropertyOverride('DesiredCount', cdk.Fn.conditionIf(serviceDisabled.logicalId, 0, cdk.Aws.NO_VALUE));

    const autoScaling = this.service.autoScaleTaskCount({
      minCapacity: this.cfnParameters.minTaskCount.valueAsNumber,
      maxCapacity: this.cfnParameters.maxTaskCount.valueAsNumber,
    });
    autoScaling.scaleOnCpuUtilization('ScaleOnCpu', {
      targetUtilizationPercent: 50,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });
  }
}
